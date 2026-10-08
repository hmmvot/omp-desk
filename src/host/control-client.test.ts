/**
 * Tests for the authenticated, read-only host-control channel (ADR-0003, narrowed
 * by ADR-0038) and its host-generated, peer-verified key delivery (ADR-0006).
 *
 * The native side and the VS Code side are exercised against each other over a
 * real named pipe: `startHostControlServer` runs the engine an OMP `-e` extension
 * would run, with a fake host adapter standing in for OMP, and a real
 * `HostControlClient` connects through a **fake peer bridge**. The fake bridge
 * stands in only for the PowerShell helper's OS query: it reports the peer facts
 * it was told to report, while the production comparison, key unwrap, HMAC
 * handshake and refusal logic all run unchanged. Adversarial cases use scripted
 * peers on their own pipe.
 *
 * Runner: `node --test src/host/control-client.test.ts` (Node's native type
 * stripping, no test-runner dependency).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CONTROL_DIR_ENV,
	CONTROL_MAX_RENDEZVOUS_BYTES,
	CONTROL_MAX_TOOL_NAME_CHARS,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SLOT_ENV,
	type ControlClientFrame,
	type ControlHostBinding,
	type ControlRendezvous,
	type ControlServerFrame,
	controlDigest,
	controlEndpoint,
	controlErrorMac,
	controlHandshakeMac,
	controlPipeName,
	controlRecipientFingerprint,
	controlRendezvousPath,
	controlResponseMac,
	createControlKey,
	createControlNonce,
	createControlSlotId,
	encodeControlFrame,
	encryptControlKeyToRecipient,
	listControlPipeNames,
	parseControlClientFrame,
	parseControlServerFrame,
	readControlRendezvous,
	removeOwnControlRendezvous,
	verifyControlRequestMac,
	writeControlRendezvous,
} from "./control-protocol.ts";
import {
	type ControlPeerBridge,
	HostControlClient,
	HostControlIdentityError,
	HostControlPeerError,
	HostControlUnavailableError,
	HostControlProtocolViolationError,
	HostControlUsageError,
	type HostControlVerifiedConnection,
	createControlRecipient,
	queryControlProcessGeneration,
	setControlHelperScript,
} from "./control-client.ts";
import {
	type HostControlAdapter,
	type HostControlFacts,
	type HostControlServer,
	type OmpExtensionAPI,
	type OmpExtensionContext,
	type OmpSessionManager,
	type OmpToolInfo,
	SESSION_IDENTITY_UNREADABLE,
	createOmpHostControlAdapter,
	hostControlExtension,
	readControlLaunchMetadata,
	startHostControlServer,
} from "../omp/host-control.ts";
import { stageRuntimeAssets } from "../runtime-assets.ts";
import { NativeActivityLedger } from "./native-activity.ts";

const tempDirs: string[] = [];
const servers: HostControlServer[] = [];
const extraSockets: Socket[] = [];

/** Generation both sides agree on in tests; the real one comes from the OS. */
const TEST_GENERATION = "133400000000000000";

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * A storage directory the stager can verify: under the local application data,
 * whose ancestor chain is trusted on this machine, because the shared temporary
 * directory is deliberately refused by the access verification.
 */
async function makeStagingDir(): Promise<string> {
	const base = process.env.LOCALAPPDATA ?? tmpdir();
	const root = await mkdtemp(path.join(base, "omp-control-helper-"));
	tempDirs.push(root);
	return path.join(root, "globalStorage");
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await readFile(target);
		return true;
	} catch {
		return false;
	}
}

/** Assert that `promise` rejects and return the error it produced. */
async function caught(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected the promise to reject");
}

after(async () => {
	for (const server of servers) await server.stop("test-teardown").catch(() => {});
	for (const socket of extraSockets) socket.destroy();
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

interface FakeHostState {
	sessionFile: string | null;
	/**
	 * Whether the fake host can read its session identity at all. `false` models
	 * a session API whose read threw or changed shape: `sessionFile` then proves
	 * nothing, which is a different state from a session with no file yet.
	 */
	sessionIdentityKnown: boolean;
	tools: {
		all: string[];
		active: string[];
	};
}

interface FakeAdapterOptions {
	/** Whether the host can describe its tool catalogue at all. */
	toolsAvailable?: boolean;
	adapter?: HostControlAdapter;
}

interface FakeAdapter {
	adapter: HostControlAdapter;
	host: FakeHostState;
}

/** Limitation text a host with no tool catalogue advertises. */
const FAKE_TOOL_GAP = "this OMP build exposes no tool catalogue API";

function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
	const host: FakeHostState = {
		sessionFile: path.join("C:", "sessions", "chat.jsonl"),
		sessionIdentityKnown: true,
		tools: {
			all: ["read", "write", "edit", "bash", "ast_grep"],
			active: ["read", "write", "edit"],
		},
	};
	const toolsAvailable = (): boolean => options.toolsAvailable !== false;
	const adapter: HostControlAdapter = {
		describeVersion: () => "18.4.3",
		cwd: process.cwd(),
		readFacts: async (): Promise<HostControlFacts> => ({
			sessionFile: host.sessionFile,
			sessionIdentityKnown: host.sessionIdentityKnown,
			readGaps: [],
		}),
		listTools: async () =>
			toolsAvailable()
				? {
						available: true,
						all: [...host.tools.all],
						active: [...host.tools.active],
						unavailableReason: null,
					}
				: { available: false, all: [], active: [], unavailableReason: FAKE_TOOL_GAP },
	};
	return { adapter, host };
}

interface FakeBridgeOptions {
	/** Peer facts to report; defaults to echoing what the caller expects. */
	readonly reportPid?: number;
	readonly reportCreation?: string;
	/** Endpoint to connect to; defaults to the pipe name under `directory`. */
	readonly endpoint?: string;
	/** Simulates a helper that cannot start at all. */
	readonly fail?: HostControlPeerError;
}

/**
 * The fake bridge only supplies the OS facts and the byte channel. It is never
 * trusted: `connectVerified` re-checks the PID and generation it reports, and all
 * key handling and HMAC logic runs in the production code under test.
 */
function fakePeerBridge(directory: string, options: FakeBridgeOptions = {}): ControlPeerBridge {
	return {
		async open(request) {
			if (options.fail) throw options.fail;
			const endpoint = options.endpoint ?? controlEndpoint(request.pipeName, directory);
			const socket = connect({ path: endpoint });
			const connected = Promise.withResolvers<void>();
			socket.once("connect", () => connected.resolve());
			socket.once("error", error => connected.reject(error));
			await connected.promise;
			extraSockets.push(socket);
			const dataListeners: Array<(bytes: Buffer) => void> = [];
			const pendingData: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => {
				if (dataListeners.length === 0) pendingData.push(chunk);
				else for (const listener of dataListeners) listener(chunk);
			});
			const closed = Promise.withResolvers<string | null>();
			socket.on("close", () => closed.resolve("test bridge closed"));
			socket.on("error", error => closed.resolve(`test bridge error: ${error.message}`));
			return {
				proof: {
					serverPid: options.reportPid ?? request.expectedPid,
					serverCreationTime: options.reportCreation ?? request.expectedCreationTime,
				},
				write(bytes) {
					socket.write(Buffer.from(bytes));
				},
				onData(listener) {
					dataListeners.push(listener);
					for (const chunk of pendingData) listener(chunk);
					pendingData.length = 0;
				},
				closed: closed.promise,
				close() {
					socket.destroy();
				},
			};
		},
	};
}

interface StartedChannel {
	server: HostControlServer;
	directory: string;
	slotId: string;
	rendezvous: ControlRendezvous;
	fake: FakeAdapter;
	recipientPrivateKeyPkcs8Pem: string;
	recipientPublicKeySpkiBase64url: string;
	/**
	 * Another control server of the same process and slot, with its own key and pipe.
	 * An older host build starts one for every in-process subagent session; the last
	 * writer owns the slot's rendezvous record.
	 */
	startSibling(): Promise<HostControlServer>;
	connect(overrides?: {
		provenKey?: string;
		rendezvous?: ControlRendezvous;
		expectedPid?: number;
		expectedProcessCreationTime?: string;
		expectedSessionFile?: string | null;
		recipientPrivateKeyPkcs8Pem?: string;
		bridge?: ControlPeerBridge;
	}): Promise<HostControlVerifiedConnection>;
	attach(overrides: {
		provenKey: string;
		preferredPipeName?: string | undefined;
		expectedSessionFile?: string | null;
		bridge?: ControlPeerBridge;
		listPipes?: (slotId: string, directory: string) => Promise<string[]>;
	}): Promise<HostControlVerifiedConnection | null>;
}

async function startChannel(prefix: string, options: FakeAdapterOptions = {}): Promise<StartedChannel> {
	const directory = await makeTempDir(prefix);
	const slotId = createControlSlotId();
	const recipient = await createControlRecipient();
	const fake = createFakeAdapter(options);
	const startServer = async (): Promise<HostControlServer> => {
		const pipeName = controlPipeName(slotId);
		const server = await startHostControlServer({
			adapter: options.adapter ?? fake.adapter,
			recipientPublicKey: recipient.publicKeySpkiBase64url,
			slotId,
			pipeName,
			endpoint: controlEndpoint(pipeName, directory),
			rendezvousDirectory: directory,
		});
		servers.push(server);
		return server;
	};
	const server = await startServer();
	const rendezvous = await readControlRendezvous(directory, slotId);
	assert.ok(rendezvous, "the native side must publish a rendezvous record after listening");
	return {
		server,
		directory,
		slotId,
		rendezvous,
		fake,
		recipientPrivateKeyPkcs8Pem: recipient.privateKeyPkcs8Pem,
		recipientPublicKeySpkiBase64url: recipient.publicKeySpkiBase64url,
		startSibling: startServer,
		connect: overrides =>
			HostControlClient.connectVerified(
				{
					rendezvous: overrides?.rendezvous ?? rendezvous,
					rendezvousDirectory: directory,
					recipientPrivateKeyPkcs8Pem:
						overrides?.recipientPrivateKeyPkcs8Pem ?? recipient.privateKeyPkcs8Pem,
					expectedPid: overrides?.expectedPid ?? process.pid,
					expectedProcessCreationTime:
						overrides?.expectedProcessCreationTime ?? TEST_GENERATION,
					expectation: { sessionFile: overrides?.expectedSessionFile ?? null, cwd: process.cwd() },
					...(overrides?.provenKey === undefined ? {} : { provenKey: overrides.provenKey }),
				},
				overrides?.bridge ?? fakePeerBridge(directory),
			),
		attach: overrides =>
			HostControlClient.connectWithProvenKey(
				{
					slotId,
					directory,
					provenKey: overrides.provenKey,
					expectedPid: process.pid,
					expectedProcessCreationTime: TEST_GENERATION,
					expectation: { sessionFile: overrides.expectedSessionFile ?? null, cwd: process.cwd() },
					...(overrides.preferredPipeName === undefined ? {} : { preferredPipeName: overrides.preferredPipeName }),
					...(overrides.listPipes === undefined ? {} : { listPipes: overrides.listPipes }),
				},
				overrides.bridge ?? fakePeerBridge(directory),
			),
	};
}

interface ScriptedPeer {
	endpoint: string;
	pipeName: string;
	received: unknown[];
	stop(): Promise<void>;
}

async function startScriptedPeer(
	directory: string,
	onFrame: (frame: unknown, reply: (frame: ControlServerFrame) => void) => void,
): Promise<ScriptedPeer> {
	const pipeName = controlPipeName(createControlSlotId());
	const endpoint = controlEndpoint(pipeName, directory);
	const received: unknown[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer(socket => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				const frame: unknown = JSON.parse(line);
				received.push(frame);
				onFrame(frame, next => socket.write(encodeControlFrame(next)));
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(endpoint, () => resolve());
	});
	return {
		endpoint,
		pipeName,
		received,
		stop: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

/** A rendezvous record a peer serves, with a real sealed key, written to disk. */
async function forgedRendezvous(
	directory: string,
	peer: ScriptedPeer,
	recipientPublicKeySpkiBase64url: string,
	controlKey: string,
): Promise<ControlRendezvous> {
	const record: ControlRendezvous = {
		version: CONTROL_PROTOCOL_VERSION,
		service: "omp-vscode-host-control",
		slotId: createControlSlotId(),
		endpoint: peer.endpoint,
		pipeName: peer.pipeName,
		instanceId: "inst-forged-0000-0000-0000-000000000000",
		epoch: "epo-forged-0000-0000-0000-000000000000",
		pid: process.pid,
		sessionFile: null,
		cwd: directory,
		ompVersion: "18.2.11",
		ciphertext: encryptControlKeyToRecipient(controlKey, recipientPublicKeySpkiBase64url),
		recipientFingerprint: controlRecipientFingerprint(recipientPublicKeySpkiBase64url),
		startedAt: Date.now(),
	};
	await writeControlRendezvous(directory, record);
	return record;
}

/** The binding a scripted peer claims inside its challenge. */
function scriptedBinding(rendezvous: ControlRendezvous, directory: string): ControlHostBinding {
	return {
		slotId: rendezvous.slotId,
		endpoint: rendezvous.endpoint,
		pipeName: rendezvous.pipeName,
		instanceId: rendezvous.instanceId,
		epoch: rendezvous.epoch,
		pid: rendezvous.pid,
		sessionFile: null,
		cwd: directory,
		ompVersion: "18.2.11",
	};
}

interface ScriptedSocket {
	next(): Promise<string>;
	send(frame: ControlClientFrame): void;
	close(): void;
	closed: Promise<void>;
}

async function openScriptedSocket(endpoint: string): Promise<ScriptedSocket> {
	const socket = connect({ path: endpoint });
	extraSockets.push(socket);
	const closed = new Promise<void>(resolve => socket.once("close", resolve));
	socket.setEncoding("utf8");
	const lines: string[] = [];
	const waiters: Array<(line: string) => void> = [];
	let buffer = "";
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			const waiter = waiters.shift();
			if (waiter) waiter(line);
			else lines.push(line);
		}
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	return {
		next: async () => {
			const queued = lines.shift();
			if (queued !== undefined) return queued;
			return new Promise<string>(resolve => waiters.push(resolve));
		},
		send: frame => socket.write(encodeControlFrame(frame)),
		close: () => socket.destroy(),
		closed,
	};
}

function fakeContext(): OmpExtensionContext {
	return {
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
			getCwd: () => process.cwd(),
		},
	};
}

function fakeExtensionApi(
	register?: (event: string, handler: (event: unknown, context: OmpExtensionContext) => unknown) => void,
): OmpExtensionAPI {
	return {
		on: (event, handler) => {
			register?.(event, handler);
		},
		getActiveTools: () => [],
		getAllTools: () => [],
	};
}

/** An extension API from a build that predates the tool catalogue methods. */
function preToolExtensionApi(): OmpExtensionAPI {
	const api = fakeExtensionApi();
	const absent = api as Partial<OmpExtensionAPI>;
	delete absent.getActiveTools;
	delete absent.getAllTools;
	return api;
}

describe("host control channel", () => {
	it("reports the live session identity to a verified client", async () => {
		const channel = await startChannel("omp-control-");
		const { client, key } = await channel.connect();
		try {
			assert.ok(key.length > 0, "the verified connection must return the proven key");
			const snapshot = await client.snapshot();
			assert.equal(snapshot.host.sessionFile, channel.fake.host.sessionFile);
			assert.equal(snapshot.host.instanceId, channel.server.instanceId);
			assert.deepEqual(snapshot.readGaps, []);
			// The channel is read-only: model, thinking level and mutation state are
			// rpc-ui's, so none of them is part of what a snapshot or a binding carries.
			assert.deepEqual(Object.keys(snapshot).sort(), ["host", "readGaps"]);
			assert.deepEqual(Object.keys(snapshot.host).sort(), [
				"cwd",
				"endpoint",
				"epoch",
				"instanceId",
				"ompVersion",
				"pid",
				"pipeName",
				"sessionFile",
				"slotId",
			]);
			assert.ok(
				!JSON.stringify(channel.rendezvous).includes(key),
				"the rendezvous must never contain the plaintext key",
			);
		} finally {
			client.close();
		}
	});

	it("refuses a pinned session when the authenticated host cannot identify its session", async () => {
		const channel = await startChannel("omp-control-session-pin-");
		const expected = channel.fake.host.sessionFile;
		assert.ok(expected);
		channel.fake.host.sessionFile = null;
		const missing = await caught(channel.connect({ expectedSessionFile: expected }));
		assert.ok(missing instanceof HostControlIdentityError);
		assert.equal((missing as HostControlIdentityError).reason, "session-mismatch");

		channel.fake.host.sessionFile = path.join("C:", "sessions", "different.jsonl");
		const wrong = await caught(channel.connect({ expectedSessionFile: expected }));
		assert.ok(wrong instanceof HostControlIdentityError);
		assert.equal((wrong as HostControlIdentityError).reason, "session-mismatch");
	});

	it("proves the peer on an open channel and refuses to prove one that has closed", async () => {
		const channel = await startChannel("omp-control-proof-");
		const { client } = await channel.connect();
		// The proof is read on the very handle the OS identified: while the channel is
		// open it names the server process and its kernel creation time.
		const proof = client.peerProof;
		assert.equal(typeof proof.serverPid, "number");
		assert.ok(proof.serverCreationTime.length > 0);

		client.close();
		// A retained binding must never be read as a live proof: the accessor refuses
		// once the channel is gone, which is what makes "a closed client cannot
		// authorize recorder facts" true.
		const closed = await caught(Promise.resolve().then(() => client.peerProof));
		assert.ok(closed instanceof HostControlUsageError, `unexpected error: ${closed.message}`);
	});

	it("refuses a peer whose PID or generation is not the recorded one", async () => {
		const channel = await startChannel("omp-control-peer-");
		const wrongPid = await caught(
			channel.connect({ bridge: fakePeerBridge(channel.directory, { reportPid: process.pid + 1 }) }),
		);
		assert.ok(wrongPid instanceof HostControlPeerError, `unexpected error: ${wrongPid.message}`);
		assert.equal((wrongPid as HostControlPeerError).reason, "pid-mismatch");

		const wrongGeneration = await caught(
			channel.connect({
				bridge: fakePeerBridge(channel.directory, { reportCreation: "133400000000000001" }),
			}),
		);
		assert.ok(wrongGeneration instanceof HostControlPeerError);
		assert.equal((wrongGeneration as HostControlPeerError).reason, "generation-mismatch");

		const unavailable = await caught(
			channel.connect({
				bridge: fakePeerBridge(channel.directory, {
					fail: new HostControlPeerError("helper-unavailable", "powershell is blocked here"),
				}),
			}),
		);
		assert.ok(unavailable instanceof HostControlPeerError);
		assert.equal((unavailable as HostControlPeerError).reason, "helper-unavailable");
	});

	it("refuses oversized valid JSON rendezvous before parsing or deleting it", async () => {
		const channel = await startChannel("omp-control-rendezvous-cap-");
		const file = controlRendezvousPath(channel.directory, channel.slotId);
		const padded = `${JSON.stringify(channel.rendezvous)}${" ".repeat(CONTROL_MAX_RENDEZVOUS_BYTES)}`;
		await writeFile(file, padded, "utf8");
		assert.equal(await readControlRendezvous(channel.directory, channel.slotId), null);
		await removeOwnControlRendezvous(channel.directory, channel.slotId, channel.server.instanceId);
		assert.equal((await readFile(file, "utf8")).length, padded.length);
	});

	it("refuses a rendezvous sealed to a different recipient or changed under it", async () => {
		const channel = await startChannel("omp-control-recipient-");
		const other = await createControlRecipient();
		const foreign = await caught(
			channel.connect({ recipientPrivateKeyPkcs8Pem: other.privateKeyPkcs8Pem }),
		);
		assert.ok(foreign instanceof HostControlIdentityError, `unexpected error: ${foreign.message}`);
		assert.equal((foreign as HostControlIdentityError).reason, "recipient-mismatch");

		// The file is re-read before connecting: a swap is refused, not trusted.
		const path = controlRendezvousPath(channel.directory, channel.slotId);
		const original = await readFile(path, "utf8");
		await writeFile(path, `${JSON.stringify({ ...channel.rendezvous, ciphertext: "A".repeat(342) })}\n`, "utf8");
		const swapped = await caught(channel.connect());
		assert.ok(swapped instanceof HostControlIdentityError);
		assert.equal((swapped as HostControlIdentityError).reason, "rendezvous-mismatch");
		await writeFile(path, original, "utf8");

		// A tampered ciphertext that no longer opens is refused as such.
		await writeFile(
			path,
			`${JSON.stringify({ ...channel.rendezvous, ciphertext: "B".repeat(342) })}\n`,
			"utf8",
		);
		const republished = await readControlRendezvous(channel.directory, channel.slotId);
		assert.ok(republished);
		const tampered = await caught(
			HostControlClient.connectVerified(
				{
					rendezvous: republished,
					rendezvousDirectory: channel.directory,
					recipientPrivateKeyPkcs8Pem: channel.recipientPrivateKeyPkcs8Pem,
					expectedPid: process.pid,
					expectedProcessCreationTime: TEST_GENERATION,
					expectation: { sessionFile: null, cwd: process.cwd() },
				},
				fakePeerBridge(channel.directory),
			),
		);
		assert.ok(tampered instanceof HostControlIdentityError);
		assert.equal((tampered as HostControlIdentityError).reason, "ciphertext-invalid");
		await writeFile(path, original, "utf8");
	});

	it("accepts a changed key only as a rotation the same proven process proves", async () => {
		const channel = await startChannel("omp-control-rotation-");
		const first = await channel.connect();
		const provenKey = first.key;
		first.client.close();

		const again = await channel.connect({ provenKey });
		assert.equal(again.key, provenKey, "a reconnect must reuse the proven key");
		assert.equal(again.rotated, false);
		again.client.close();

		// The same process now serves another server (new key, new pipe) and the
		// slot's record names it: the host proves the new key on the pinned process.
		const sibling = await channel.startSibling();
		const record = await readControlRendezvous(channel.directory, channel.slotId);
		assert.equal(record?.instanceId, sibling.instanceId);
		const rotated = await channel.connect({ provenKey, rendezvous: record ?? channel.rendezvous });
		try {
			assert.equal(rotated.rotated, true);
			assert.notEqual(rotated.key, provenKey, "the caller is handed the new key to pin");
			assert.equal((await rotated.client.snapshot()).host.instanceId, sibling.instanceId);
		} finally {
			rotated.client.close();
		}
	});

	it("still refuses a foreign key, a foreign process and a host that cannot prove the new key", async () => {
		const channel = await startChannel("omp-control-foreign-key-");
		const first = await channel.connect();
		const provenKey = first.key;
		first.client.close();
		const sibling = await channel.startSibling();
		const record = await readControlRendezvous(channel.directory, channel.slotId);
		assert.ok(record);
		assert.equal(record.instanceId, sibling.instanceId);

		// A record for another process cannot rotate the pinned key, whatever it carries.
		const foreignRecord: ControlRendezvous = { ...record, pid: process.pid + 1 };
		await writeControlRendezvous(channel.directory, foreignRecord);
		const otherProcess = await caught(channel.connect({ provenKey, rendezvous: foreignRecord }));
		assert.ok(otherProcess instanceof HostControlIdentityError, `unexpected error: ${otherProcess.message}`);
		assert.equal((otherProcess as HostControlIdentityError).reason, "key-changed");

		// A pipe the OS shows another process serving is never dialled past the proof.
		await writeControlRendezvous(channel.directory, record);
		const impostor = await caught(
			channel.connect({
				provenKey,
				rendezvous: record,
				bridge: fakePeerBridge(channel.directory, { reportPid: process.pid + 1 }),
			}),
		);
		assert.ok(impostor instanceof HostControlPeerError, `unexpected error: ${impostor.message}`);
		assert.equal((impostor as HostControlPeerError).reason, "pid-mismatch");

		// A record sealed to this recipient with a key the live server does not hold.
		const forged: ControlRendezvous = {
			...record,
			ciphertext: encryptControlKeyToRecipient(createControlKey(), channel.recipientPublicKeySpkiBase64url),
		};
		await writeControlRendezvous(channel.directory, forged);
		const unproven = await caught(channel.connect({ provenKey, rendezvous: forged }));
		assert.ok(unproven instanceof HostControlIdentityError, `unexpected error: ${unproven.message}`);
		assert.equal((unproven as HostControlIdentityError).reason, "key-mismatch");
	});

	it("reattaches by the proven key when the record names another server or is gone", async () => {
		const channel = await startChannel("omp-control-proven-key-");
		const first = await channel.connect();
		const provenKey = first.key;
		first.client.close();

		// An older host build starts a server for a subagent session and overwrites the record.
		const sibling = await channel.startSibling();
		const clobbered = await readControlRendezvous(channel.directory, channel.slotId);
		assert.equal(clobbered?.instanceId, sibling.instanceId);
		const viaClobbered = await channel.attach({ provenKey, preferredPipeName: clobbered?.pipeName });
		assert.ok(viaClobbered, "the original server must be found although the record names the subagent's");
		try {
			assert.equal(viaClobbered.rotated, false);
			assert.equal(viaClobbered.key, provenKey);
			assert.equal((await viaClobbered.client.snapshot()).host.instanceId, channel.server.instanceId);
		} finally {
			viaClobbered.client.close();
		}

		// The subagent's server stops and removes the record it owned: nothing publishes now.
		await sibling.stop("subagent-finished");
		assert.equal(await readControlRendezvous(channel.directory, channel.slotId), null);
		const withoutRecord = await channel.attach({ provenKey });
		assert.ok(withoutRecord, "a missing record must not strand a host that is alive");
		try {
			assert.equal((await withoutRecord.client.snapshot()).host.instanceId, channel.server.instanceId);
		} finally {
			withoutRecord.client.close();
		}
	});

	it("finds the original server among many servers an older host leaked for finished subagents", async () => {
		const channel = await startChannel("omp-control-proven-key-leaks-");
		const first = await channel.connect();
		const provenKey = first.key;
		first.client.close();
		for (let leaked = 0; leaked < 12; leaked++) await channel.startSibling();

		const found = await channel.attach({ provenKey });
		assert.ok(found, "the original server must be found although twelve others share its slot");
		try {
			assert.equal((await found.client.snapshot()).host.instanceId, channel.server.instanceId);
		} finally {
			found.client.close();
		}
	});

	it("does not trust a pipe for its name when attaching by the proven key", async () => {
		const channel = await startChannel("omp-control-proven-key-refuse-");
		const first = await channel.connect();
		const provenKey = first.key;
		first.client.close();

		assert.equal(await channel.attach({ provenKey: createControlKey() }), null, "no server proves a key it does not hold");
		assert.equal(
			await channel.attach({
				provenKey,
				bridge: fakePeerBridge(channel.directory, { reportCreation: "133400000000000001" }),
			}),
			null,
			"a pipe served by another process generation is skipped",
		);
		assert.equal(
			await channel.attach({ provenKey, listPipes: async () => [] }),
			null,
			"with no pipe for the slot nothing is attached",
		);

		// A listed pipe that cannot be examined may still be the pinned server: absence is not concluded.
		const unreachable = await caught(
			channel.attach({
				provenKey: createControlKey(),
				listPipes: async () => [controlPipeName(channel.slotId)],
			}),
		);
		assert.ok(unreachable instanceof HostControlUnavailableError, `unexpected error: ${unreachable.message}`);
		const tooMany = await caught(
			channel.attach({
				provenKey,
				bridge: fakePeerBridge(channel.directory, { reportCreation: "133400000000000001" }),
				listPipes: async () => Array.from({ length: 33 }, () => channel.server.pipeName),
			}),
		);
		assert.ok(tooMany instanceof HostControlUnavailableError, `unexpected error: ${tooMany.message}`);

		const wrongSession = await caught(
			channel.attach({ provenKey, expectedSessionFile: path.join("C:", "sessions", "other.jsonl") }),
		);
		assert.ok(wrongSession instanceof HostControlIdentityError, `unexpected error: ${wrongSession.message}`);
		assert.equal((wrongSession as HostControlIdentityError).reason, "session-mismatch");

		const noHelper = await caught(
			channel.attach({
				provenKey,
				bridge: fakePeerBridge(channel.directory, {
					fail: new HostControlPeerError("helper-unavailable", "powershell is blocked here"),
				}),
			}),
		);
		assert.ok(noHelper instanceof HostControlPeerError);
		assert.equal((noHelper as HostControlPeerError).reason, "helper-unavailable");
	});

	it("refuses an endpoint that cannot prove the key, and sends it nothing but a nonce", async () => {
		const directory = await makeTempDir("omp-control-impostor-");
		const recipient = await createControlRecipient();
		let claim: ControlRendezvous | null = null;
		const peer = await startScriptedPeer(directory, (frame, reply) => {
			const parsed = parseControlClientFrame(frame);
			if (parsed?.kind !== "hello" || !claim) return;
			reply({
				v: CONTROL_PROTOCOL_VERSION,
				kind: "challenge",
				serverNonce: createControlNonce(),
				host: scriptedBinding(claim, directory),
				mac: createControlNonce(),
			});
		});
		const forged = await forgedRendezvous(
			directory,
			peer,
			recipient.publicKeySpkiBase64url,
			createControlKey(),
		);
		claim = forged;
		try {
			const error = await caught(
				HostControlClient.connectVerified(
					{
						rendezvous: forged,
						rendezvousDirectory: directory,
						recipientPrivateKeyPkcs8Pem: recipient.privateKeyPkcs8Pem,
						expectedPid: process.pid,
						expectedProcessCreationTime: TEST_GENERATION,
						expectation: { sessionFile: null, cwd: directory },
					},
					fakePeerBridge(directory, { endpoint: peer.endpoint }),
				),
			);
			assert.ok(error instanceof HostControlIdentityError, `unexpected error: ${error.message}`);
			assert.equal((error as HostControlIdentityError).reason, "key-mismatch");
			assert.equal(peer.received.length, 1, "no request may be sent before the host proves its key");
		} finally {
			await peer.stop();
		}
	});

	it("rejects a response whose digest does not cover its payload", async () => {
		const directory = await makeTempDir("omp-control-hostile-");
		const recipient = await createControlRecipient();
		const key = createControlKey();
		let claim: ControlRendezvous | null = null;
		let requestSignatureVerified = false;
		const peer = await startScriptedPeer(directory, (frame, reply) => {
			const parsed = parseControlClientFrame(frame);
			if (!claim) return;
			const binding = scriptedBinding(claim, directory);
			if (parsed?.kind === "hello") {
				const serverNonce = createControlNonce();
				reply({
					v: CONTROL_PROTOCOL_VERSION,
					kind: "challenge",
					serverNonce,
					host: binding,
					mac: controlHandshakeMac(key, { clientNonce: parsed.clientNonce, serverNonce, host: binding }),
				});
				return;
			}
			if (parsed?.kind !== "request") return;
			requestSignatureVerified = verifyControlRequestMac(
				key,
				{
					clientNonce: parsed.clientNonce,
					serverNonce: parsed.serverNonce,
					requestId: parsed.requestId,
					method: parsed.method,
					digest: parsed.digest,
				},
				parsed.mac,
			);
			const wrongDigest = "b".repeat(64);
			reply({
				v: CONTROL_PROTOCOL_VERSION,
				kind: "response",
				requestId: parsed.requestId,
				result: {
					kind: "listTools",
					list: { available: true, all: [], active: [], unavailableReason: null },
				},
				digest: wrongDigest,
				host: binding,
				mac: controlResponseMac(key, {
					clientNonce: parsed.clientNonce,
					serverNonce: parsed.serverNonce,
					requestId: parsed.requestId,
					digest: wrongDigest,
				}),
			});
		});
		const forged = await forgedRendezvous(directory, peer, recipient.publicKeySpkiBase64url, key);
		claim = forged;
		try {
			const { client } = await HostControlClient.connectVerified(
				{
					rendezvous: forged,
					rendezvousDirectory: directory,
					recipientPrivateKeyPkcs8Pem: recipient.privateKeyPkcs8Pem,
					expectedPid: process.pid,
					expectedProcessCreationTime: TEST_GENERATION,
					expectation: { sessionFile: null, cwd: directory },
				},
				fakePeerBridge(directory, { endpoint: peer.endpoint }),
			);
			const error = await caught(client.listTools());
			assert.ok(
				error instanceof HostControlProtocolViolationError,
				`unexpected error: ${error.message}`,
			);
			assert.match(error.message, /digest/);
			assert.ok(requestSignatureVerified, "the client must sign its request with the key");
		} finally {
			await peer.stop();
		}
	});

	it("rejects a replayed handshake nonce", async () => {
		const channel = await startChannel("omp-control-replay-");
		const replay = createControlNonce();
		const first = await openScriptedSocket(channel.rendezvous.endpoint);
		first.send({ v: CONTROL_PROTOCOL_VERSION, kind: "hello", clientNonce: replay });
		assert.equal(parseControlServerFrame(JSON.parse(await first.next()))?.kind, "challenge");

		const second = await openScriptedSocket(channel.rendezvous.endpoint);
		second.send({ v: CONTROL_PROTOCOL_VERSION, kind: "hello", clientNonce: replay });
		const frame = parseControlServerFrame(JSON.parse(await second.next()));
		assert.equal(frame?.kind === "error" ? frame.code : null, "replayed-nonce");
		first.close();
		second.close();
	});

	it("expires a hello-only peer that never proves knowledge of the control key", { timeout: 9_000 }, async () => {
		const channel = await startChannel("omp-control-stalled-");
		const stalled = await openScriptedSocket(channel.rendezvous.endpoint);
		stalled.send({ v: CONTROL_PROTOCOL_VERSION, kind: "hello", clientNonce: createControlNonce() });
		assert.equal(parseControlServerFrame(JSON.parse(await stalled.next()))?.kind, "challenge");
		await stalled.closed;
		const { client } = await channel.connect();
		try {
			assert.equal((await client.snapshot()).host.pid, process.pid);
		} finally {
			client.close();
		}
	});

	it("reports an unreadable session identity as a gap, never as a session without a file", async () => {
		const channel = await startChannel("omp-control-identity-");
		// The session API throws (or answers in an unknown shape) while a stale
		// path is still remembered: an unproven value must not satisfy a pin.
		channel.fake.host.sessionIdentityKnown = false;
		const { client } = await channel.connect({ expectedSessionFile: null });
		try {
			const unread = await client.snapshot();
			assert.equal(unread.host.sessionFile, null, "an unread identity carries no session file");
			assert.ok(
				unread.readGaps.includes(SESSION_IDENTITY_UNREADABLE),
				`the unread identity must be reported: ${JSON.stringify(unread.readGaps)}`,
			);

			// A successful read of absence, as OMP reports a session before its
			// first persisted message: this is not an unknown identity.
			channel.fake.host.sessionIdentityKnown = true;
			channel.fake.host.sessionFile = null;
			const unsaved = await client.snapshot();
			assert.equal(unsaved.host.sessionFile, null);
			assert.deepEqual(unsaved.readGaps, []);
		} finally {
			client.close();
		}
	});

	it("distinguishes an unreadable session identity from a session without a file", async () => {
		const adapter = createOmpHostControlAdapter(fakeExtensionApi());
		adapter.observeContext(fakeContext());
		const absent = await adapter.readFacts();
		assert.equal(absent.sessionIdentityKnown, true, "OMP's null/undefined is a successful read");
		assert.equal(absent.sessionFile, null);

		adapter.observeContext({
			...fakeContext(),
			sessionManager: {
				getSessionFile: (): string | null => {
					throw new Error("the session API changed");
				},
				getSessionId: () => "session-test",
				getCwd: () => process.cwd(),
			},
		});
		const threw = await adapter.readFacts();
		assert.equal(threw.sessionIdentityKnown, false);
		assert.equal(threw.sessionFile, null);
		assert.ok(threw.readGaps.includes(SESSION_IDENTITY_UNREADABLE));

		// A build whose session manager no longer exposes the getter is unread as
		// well, never "this session has no file".
		const stripped = fakeContext();
		const partial = stripped.sessionManager as Partial<OmpSessionManager>;
		delete partial.getSessionFile;
		adapter.observeContext(stripped);
		assert.equal((await adapter.readFacts()).sessionIdentityKnown, false);

		adapter.observeContext({
			...fakeContext(),
			sessionManager: {
				getSessionFile: () => path.join("C:", "sessions", "chat.jsonl"),
				getSessionId: () => "session-test",
				getCwd: () => process.cwd(),
			},
		});
		const present = await adapter.readFacts();
		assert.equal(present.sessionIdentityKnown, true);
		assert.equal(present.sessionFile, path.join("C:", "sessions", "chat.jsonl"));
	});

	it("names the session as read now on every answer and mints a new epoch on a transition", async () => {
		const channel = await startChannel("omp-control-transition-");
		const { client } = await channel.connect();
		try {
			const first = await client.snapshot();
			const other = path.join("C:", "sessions", "other.jsonl");
			channel.fake.host.sessionFile = other;
			await client.listTools();
			assert.equal(
				client.latestHost?.sessionFile,
				other,
				"a tool read must not answer with the session file of an older observation",
			);
			assert.equal(client.latestHost?.epoch, first.host.epoch, "reading does not change the session generation");

			channel.server.noteSessionTransition();
			const second = await client.snapshot();
			assert.notEqual(second.host.epoch, first.host.epoch, "a session transition mints a new generation");
			assert.equal(second.host.instanceId, first.host.instanceId, "the process is still the same one");
			assert.equal(second.host.sessionFile, other);
			assert.equal(client.binding.epoch, first.host.epoch, "the connection stays pinned to what it verified");
		} finally {
			client.close();
		}
	});


	it("reads only public launch metadata and refuses to serve without a recipient", async () => {
		const names = [CONTROL_DIR_ENV, CONTROL_SLOT_ENV] as const;
		const saved = names.map(name => process.env[name]);
		const directory = await makeTempDir("omp-control-launch-");
		const slotId = createControlSlotId();
		const warnings: string[] = [];
		try {
			for (const name of names) delete process.env[name];
			assert.deepEqual(readControlLaunchMetadata(), { kind: "absent" });

			process.env[CONTROL_DIR_ENV] = directory;
			process.env[CONTROL_SLOT_ENV] = "not a slot";
			const rejected = readControlLaunchMetadata();
			assert.equal(rejected.kind, "rejected");
			assert.ok(
				rejected.kind === "rejected" && rejected.reason.includes(CONTROL_SLOT_ENV),
				"a malformed slot must name the variable it came from",
			);

			process.env[CONTROL_SLOT_ENV] = slotId;
			const ready = readControlLaunchMetadata();
			assert.equal(ready.kind, "ready");

			// No `--define` in this process: the recipient is unusable, so the entry
			// serves nothing at all rather than an unencrypted channel.
			const fakePi: OmpExtensionAPI = {
				...fakeExtensionApi(),
				logger: {
					warn: (message: string): void => {
						warnings.push(message);
					},
				},
			};
			await hostControlExtension(fakePi);
			assert.equal(await readControlRendezvous(directory, slotId), null);
			assert.equal(await pathExists(controlRendezvousPath(directory, slotId)), false);
			assert.ok(warnings.some(message => message.includes("refusing host control")));
		} finally {
			names.forEach((name, index) => {
				const value = saved[index];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			});
		}
	});

	it("serves one control server per process and slot however many sessions bind the extension", async () => {
		const names = [CONTROL_DIR_ENV, CONTROL_SLOT_ENV] as const;
		const saved = names.map(name => process.env[name]);
		const globals = globalThis as { __OMP_VSCODE_RECIPIENT_PUBLIC_KEY?: string };
		const savedRecipient = globals.__OMP_VSCODE_RECIPIENT_PUBLIC_KEY;
		const directory = await makeTempDir("omp-control-singleton-");
		const slotId = createControlSlotId();
		const recipient = await createControlRecipient();
		const shutdowns: Array<() => unknown> = [];
		const bind = (): OmpExtensionAPI =>
			fakeExtensionApi((event, handler) => {
				if (event === "session_shutdown") shutdowns.push(() => handler({}, fakeContext()));
			});
		try {
			process.env[CONTROL_DIR_ENV] = directory;
			process.env[CONTROL_SLOT_ENV] = slotId;
			globals.__OMP_VSCODE_RECIPIENT_PUBLIC_KEY = recipient.publicKeySpkiBase64url;

			await hostControlExtension(bind());
			const published = await readControlRendezvous(directory, slotId);
			assert.ok(published, "the first binding publishes the slot's record");

			// Every in-process subagent session binds the extension again. None may mint a key,
			// pipe or instance of its own, or the record the extension pinned stops naming the host.
			await hostControlExtension(bind());
			await hostControlExtension(bind());
			assert.equal((await readControlRendezvous(directory, slotId))?.instanceId, published.instanceId);
			assert.deepEqual(await listControlPipeNames(slotId, directory), [published.pipeName]);
			assert.equal(shutdowns.length, 1, "a later binding registers nothing that could stop the owner");

			// Once the owner stopped, a later binding may serve the slot again.
			await shutdowns[0]?.();
			assert.equal(await readControlRendezvous(directory, slotId), null);
			await hostControlExtension(bind());
			const successor = await readControlRendezvous(directory, slotId);
			assert.ok(successor);
			assert.notEqual(successor.instanceId, published.instanceId);
			await shutdowns[1]?.();
		} finally {
			names.forEach((name, index) => {
				const value = saved[index];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			});
			if (savedRecipient === undefined) delete globals.__OMP_VSCODE_RECIPIENT_PUBLIC_KEY;
			else globals.__OMP_VSCODE_RECIPIENT_PUBLIC_KEY = savedRecipient;
		}
	});

	it("reports a stable kernel generation for a live process", { skip: process.platform !== "win32" }, async () => {
		// The peer proof runs the staged helper copy; a real window is handed one at
		// activation, and the digest is kept beside the path because the copy is re-read
		// and re-hashed immediately before every spawn. This stages the packaged helper
		// the same way the extension does and hands the probe the staged path, so the
		// path under test is the one a window would really use.
		const packaged = fileURLToPath(new URL("./verified-pipe.ps1", import.meta.url));
		const [stagedHelper] = await stageRuntimeAssets({
			storageDir: await makeStagingDir(),
			sourcePaths: [packaged],
		});
		assert.ok(stagedHelper !== undefined);
		const helperPath = stagedHelper.path;
		const helperDigest = stagedHelper.sha256;
		assert.notEqual(helperPath, packaged, "the probe runs a staged copy, not the packaged file");
		setControlHelperScript(helperPath, helperDigest);
		const first = await queryControlProcessGeneration(process.pid);
		const second = await queryControlProcessGeneration(process.pid);
		assert.match(first, /^\d{15,}$/, "the generation is a FILETIME decimal string");
		assert.equal(second, first, "a live process keeps its creation time");

		const gone = await caught(queryControlProcessGeneration(4294967290));
		assert.ok(gone instanceof HostControlPeerError, `unexpected error: ${gone.message}`);

		// With no staged copy configured there is no helper at all: the proof refuses
		// rather than falling back to an unchecked socket.
		setControlHelperScript("", "");
		const unconfigured = await caught(queryControlProcessGeneration(process.pid));
		assert.ok(unconfigured instanceof HostControlPeerError, `unexpected error: ${unconfigured.message}`);
		assert.equal(unconfigured.reason, "helper-unavailable");

		// A copy whose bytes are no longer the ones it was staged with is refused too,
		// rather than executed under the digest it no longer has.
		setControlHelperScript(helperPath, "0".repeat(64));
		const substituted = await caught(queryControlProcessGeneration(process.pid));
		assert.ok(substituted instanceof HostControlPeerError, `unexpected error: ${substituted.message}`);
		assert.equal(substituted.reason, "helper-unavailable");
		assert.match(substituted.message, /no longer holds the bytes/);
		setControlHelperScript(helperPath, helperDigest);
	});
});

describe("host control tool catalogue", () => {
	it("lists the tools the host offers and the selection it reports active", async () => {
		const channel = await startChannel("omp-control-tools-");
		const { client } = await channel.connect();
		try {
			const list = await client.listTools();
			assert.equal(list.available, true);
			assert.deepEqual(list.all, channel.fake.host.tools.all);
			assert.deepEqual(list.active, ["read", "write", "edit"]);
			assert.equal(list.unavailableReason, null);
			// Names only: a schema, a description or a source path must never cross
			// this channel.
			assert.deepEqual(Object.keys(list).sort(), ["active", "all", "available", "unavailableReason"]);
		} finally {
			client.close();
		}
	});

	it("serves no catalogue when the host has no tool API", async () => {
		const channel = await startChannel("omp-control-tools-absent-", { toolsAvailable: false });
		const { client } = await channel.connect();
		try {
			const list = await client.listTools();
			assert.equal(list.available, false);
			assert.deepEqual(list.all, []);
			assert.deepEqual(list.active, []);
			assert.equal(list.unavailableReason, FAKE_TOOL_GAP);
		} finally {
			client.close();
		}
	});

	it("does not expose tool selection or model/thinking mutations on the control channel", () => {
		// These mutations still belong to RPC/native UI; native lifecycle actions
		// have their own target-guarded payloads.
		const frame = {
			v: CONTROL_PROTOCOL_VERSION,
			kind: "request",
			clientNonce: createControlNonce(),
			serverNonce: createControlNonce(),
			requestId: "req-00000000-0000-0000-0000-000000000051",
			method: "setActiveTools",
			digest: "0".repeat(64),
			payload: { kind: "setActiveTools", tools: ["read"] },
			mac: "a".repeat(43),
		};
		for (const method of ["setActiveTools", "setModel", "setThinking", "setTitle", "listModels", "result"]) {
			assert.equal(
				parseControlClientFrame({ ...frame, method, payload: { kind: method } }),
				null,
				`${method} is refused on the wire`,
			);
		}
		// Control: the same frame carrying a method this channel does define is a
		// valid request, so the refusals above are about the method and not the shape.
		assert.notEqual(
			parseControlClientFrame({ ...frame, method: "listTools", payload: { kind: "listTools" } }),
			null,
		);
	});

	it("maps the installed OMP tool API onto the catalogue, and fails closed without it", async () => {
		const active = ["read", "write"];
		const all = ["read", "write", "ast_grep"];
		const adapter = createOmpHostControlAdapter({
			...fakeExtensionApi(),
			getActiveTools: () => [...active],
			// The installed SDK returns full `ToolInfo` records; only names are read.
			getAllTools: () => all.map(name => ({ name, description: "ignored" }) as OmpToolInfo),
		});
		const list = await adapter.listTools();
		assert.equal(list.available, true);
		assert.deepEqual(list.all, all);
		assert.deepEqual(list.active, active);
		assert.equal(list.unavailableReason, null);

		// A name this channel cannot carry fails the whole catalogue closed: a
		// partially listed one would silently lose tools.
		const exotic = createOmpHostControlAdapter({
			...fakeExtensionApi(),
			getActiveTools: () => ["read"],
			getAllTools: () => [{ name: "x".repeat(CONTROL_MAX_TOOL_NAME_CHARS + 1) }],
		});
		const exoticList = await exotic.listTools();
		assert.equal(exoticList.available, false);
		assert.deepEqual(exoticList.all, []);

		// A build that predates the API is reported as an unreadable catalogue,
		// never as a host that offers nothing.
		const bare = createOmpHostControlAdapter(preToolExtensionApi());
		const bareList = await bare.listTools();
		assert.equal(bareList.available, false);
		assert.deepEqual(bareList.all, []);
	});
});

describe("native TUI control lifecycle", () => {
	function fixture() {
		const state = { file: path.join(tmpdir(), "native-control.jsonl"), id: "native-a", name: "First", streaming: false, queued: false, jobs: 0, deliveries: 0, aborts: 0, shutdowns: 0 };
		const adapter = createOmpHostControlAdapter({
			...fakeExtensionApi(),
			setSessionName: name => { state.name = name; },
		});
		const context: OmpExtensionContext = {
			mode: "tui",
			agent: { kind: "main" },
			sessionManager: {
				getSessionFile: () => state.file,
				getSessionId: () => state.id,
				getCwd: () => process.cwd(),
				getSessionName: () => state.name,
				getEntries: () => [{ type: "message", message: { role: "user" } }],
			},
			isIdle: () => !state.streaming,
			hasPendingMessages: () => state.queued,
			getAsyncJobSnapshot: () => ({ running: Array(state.jobs).fill({}), delivery: { queued: state.deliveries, delivering: false, pendingJobIds: [] } }),
			abort: () => { state.aborts++; state.streaming = false; },
			shutdown: () => { state.shutdowns++; },
		};
		adapter.observeContext(context);
		return { state, adapter, context };
	}

	it("refuses background-work shutdown without consent and distinguishes accepted deferred exit", async () => {
		const native = fixture();
		const channel = await startChannel("omp-native-defer-", { adapter: native.adapter });
		const { client } = await channel.connect();
		try {
			const first = await client.nativeState(true);
			assert.equal(first.hasContent, true);
			assert.equal(first.settled, true);
			const target = { epoch: client.latestHost!.epoch, sessionFile: first.sessionFile, sessionId: first.sessionId };
			native.state.jobs = 1;
			assert.equal((await client.nativeState()).settled, false);
			assert.equal(await client.nativeShutdown(target, false), "busy");
			assert.equal(native.state.shutdowns, 0);
			assert.equal(native.state.aborts, 0);
			assert.equal(await client.nativeShutdown(target, true), "accepted-deferred");
			assert.equal(native.state.aborts, 1);
			assert.equal(native.state.shutdowns, 1);
		} finally { client.close(); }
	});

	it("delivers a native completion only after authenticated readback establishes full idle", async () => {
		const native = fixture();
		const channel = await startChannel("omp-native-notice-", { adapter: native.adapter });
		const { client } = await channel.connect();
		const ledger = new NativeActivityLedger();
		try {
			ledger.observe(await client.nativeActivity(), native.state.id, null);
			native.state.streaming = true;
			native.adapter.observeActivity("agent_start", {}, native.context);
			native.adapter.observeActivity("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "private details" } }, native.context);
			native.adapter.observeActivity("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, native.context);
			assert.deepEqual(ledger.observe(await client.nativeActivity(), native.state.id, null), []);
			native.state.streaming = false;
			assert.deepEqual(ledger.observe(await client.nativeActivity(), native.state.id, null), [{ kind: "turn-complete", outcome: "error" }]);
			assert.deepEqual(ledger.observe(await client.nativeActivity(), native.state.id, null), []);
			// Existing nativeState/rename keep their original contract on the same connection.
			const original = await client.nativeState();
			const target = { epoch: client.latestHost!.epoch, sessionFile: original.sessionFile, sessionId: original.sessionId };
			assert.equal(await client.nativeRename(target, "After notification"), "renamed");
			assert.equal((await client.nativeState()).name, "After notification");
		} finally { client.close(); }
	});

	it("authenticates request-gated native work without changing old replies, then notifies only after delivery drains", async () => {
		const native = fixture();
		const channel = await startChannel("omp-native-work-", { adapter: native.adapter });
		const { client } = await channel.connect();
		const ledger = new NativeActivityLedger();
		try {
			const legacy = await client.nativeActivity();
			assert.equal("work" in legacy, false, "kind-only readers must retain their signed four-key response");
			ledger.observe(await client.nativeActivity({ work: true }), native.state.id, null);
			native.state.streaming = true; native.state.jobs = 1;
			native.adapter.observeActivity("agent_start", {}, native.context);
			native.adapter.observeActivity("message_end", { message: { role: "assistant", stopReason: "stop" } }, native.context);
			native.adapter.observeActivity("agent_end", { willContinue: true, messages: [{ role: "assistant", stopReason: "stop" }] }, native.context);
			const mainAndBackground = await client.nativeActivity({ work: true });
			assert.deepEqual(mainAndBackground.work, { working: true, backgroundWork: true });
			assert.deepEqual(ledger.observe(mainAndBackground, native.state.id, null), []);
			native.state.streaming = false;
			const background = await client.nativeActivity({ work: true });
			assert.deepEqual(background.work, { working: false, backgroundWork: true });
			assert.deepEqual(ledger.observe(background, native.state.id, null), []);
			native.state.jobs = 0; native.state.deliveries = 1;
			assert.deepEqual(ledger.observe(await client.nativeActivity({ work: true }), native.state.id, null), []);
			native.state.deliveries = 0;
			const idle = await client.nativeActivity({ work: true });
			assert.deepEqual(idle.work, { working: false, backgroundWork: false });
			assert.deepEqual(ledger.observe(idle, native.state.id, null), [{ kind: "turn-complete", outcome: "stop" }]);
			assert.deepEqual(ledger.observe(await client.nativeActivity({ work: true }), native.state.id, null), []);
			assert.equal("work" in await client.nativeActivity(), false);
			assert.equal("work" in await client.nativeState(), false, "nativeState retains its original separate strict contract");
		} finally { client.close(); }
	});

	it("answers the registry subagent request in a chat (rpc-ui) host that has no TUI context, and refuses malformed payloads", async () => {
		const registry = { refs: [] as Record<string, unknown>[] };
		const adapter = createOmpHostControlAdapter({ ...fakeExtensionApi(), pi: { AgentRegistry: { global: () => ({ list: () => registry.refs }) } } });
		adapter.observeContext({ mode: "rpc", agent: { kind: "main" }, sessionManager: { getSessionFile: () => null, getSessionId: () => "chat-a" } });
		const channel = await startChannel("omp-chat-subagents-", { adapter });
		const { client } = await channel.connect();
		try {
			assert.equal(await client.subagentWork(), false);
			registry.refs = [{ kind: "sub", status: "parked", session: null }, { kind: "main", status: "running", session: { isStreaming: true } }];
			assert.equal(await client.subagentWork(), false, "a parked agent and the main agent are not work");
			registry.refs = [{ kind: "sub", status: "running", session: { isStreaming: true, queuedMessageCount: 0 } }];
			assert.equal(await client.subagentWork(), true, "a revived running agent is work although it is no async job");
			registry.refs = [];
			assert.equal(await client.subagentWork(), false);
		} finally { client.close(); }
		const frame = {
			v: CONTROL_PROTOCOL_VERSION, kind: "request",
			clientNonce: createControlNonce(), serverNonce: createControlNonce(),
			requestId: "req-00000000-0000-0000-0000-000000000053", method: "subagentWork",
			digest: "0".repeat(64), mac: "a".repeat(43),
		};
		assert.notEqual(parseControlClientFrame({ ...frame, payload: { kind: "subagentWork" } }), null);
		for (const payload of [{ kind: "subagentWork", extra: true }, { kind: "nativeActivity" }, {}]) assert.equal(parseControlClientFrame({ ...frame, payload }), null);
	});

	it("refuses malformed or over-broad work requests rather than probing an alternate method", () => {
		const frame = {
			v: CONTROL_PROTOCOL_VERSION, kind: "request",
			clientNonce: createControlNonce(), serverNonce: createControlNonce(),
			requestId: "req-00000000-0000-0000-0000-000000000052", method: "nativeActivity",
			digest: "0".repeat(64), mac: "a".repeat(43),
		};
		for (const payload of [
			{ kind: "nativeActivity", work: false }, { kind: "nativeActivity", work: "true" },
			{ kind: "nativeActivity", work: true, includeContent: true },
		]) assert.equal(parseControlClientFrame({ ...frame, payload }), null);
		assert.notEqual(parseControlClientFrame({ ...frame, payload: { kind: "nativeActivity", work: true } }), null);
	});

	it("guards rename and shutdown against a native session change without disconnecting process-bound control", async () => {
		const native = fixture();
		const channel = await startChannel("omp-native-switch-", { adapter: native.adapter });
		const { client } = await channel.connect();
		try {
			const original = await client.nativeState();
			const target = { epoch: client.latestHost!.epoch, sessionFile: original.sessionFile, sessionId: original.sessionId };
			native.state.id = "native-b";
			native.state.file = path.join(tmpdir(), "native-b.jsonl");
			assert.equal(await client.nativeRename(target, "Wrong"), "target-changed");
			assert.equal(await client.nativeShutdown(target, true), "target-changed");
			assert.equal(native.state.name, "First");
			assert.equal(native.state.shutdowns, 0);
			const current = await client.nativeState();
			const next = { epoch: client.latestHost!.epoch, sessionFile: current.sessionFile, sessionId: current.sessionId };
			assert.equal(await client.nativeRename(next, "Current"), "renamed");
			assert.equal((await client.nativeState()).name, "Current");
			assert.equal(await client.nativeShutdown(next, false), "accepted");
			assert.equal(native.state.aborts, 0);
			assert.equal(native.state.shutdowns, 1);
		} finally { client.close(); }
	});
});
