/**
 * What re-adopting a surviving broker costs in kernel identity readings, and what it refuses.
 *
 * A fake broker speaks the real authenticated protocol over loopback (`startPtyBrokerServer`),
 * the record is published the way a broker publishes it, and the kernel reader is a counting
 * stand-in for the PowerShell probe, so each test states how many readings an attach took:
 *
 * - a broker that attests its own identity (this build's brokers) is attached with no reading at
 *   all, and the probe helper is never staged;
 * - a broker that attests nothing (an older build's) is read through the kernel, once for the
 *   broker and once for its child, and a reconcile followed by the attach reads the pair once;
 * - a dead, replaced or substituted child, and a broker that is not the one the record names, are
 *   refused on every route.
 *
 * Runner: `node --test src/host/pty-attach-identity.test.ts`
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as net from "node:net";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type { PrivateStorageCommandResult, PrivateStorageProbe } from "./private-storage.ts";
import { TEST_CURRENT_SID, fixtureAcl, fixturePrincipal } from "./private-storage-test-support.ts";
import { PTY_PROTOCOL_VERSION, PTY_RECORD_VERSION, PTY_RUNTIME_VERSION, PTY_SERVICE, createPtyGeneration, createPtyToken } from "./pty-protocol.ts";
import type { PtyBrokerRecord, PtyIdentityAttestation, PtyKind, PtyStatusPayload } from "./pty-protocol.ts";
import { startPtyBrokerServer, type PtyBrokerServer } from "./pty-ipc.ts";
import { claimPtyRecord } from "./pty-registry.ts";
import type { PtyIdentityReading, PtyProbeHelper } from "./pty-identity.ts";
import type { PtyBrokerClient as PtyBrokerClientType } from "./pty-client.ts";
import type { attachNativeHost as attachNativeHostType } from "./native-session.ts";
import type { attachRpcHost as attachRpcHostType } from "./rpc-launch.ts";
import type { probeRpcHost as probeRpcHostType } from "./rpc-reconcile.ts";
import type { BrokerPin } from "./rpc-reconcile.ts";

const VSCODE_STUB = `
export const Uri = { file: (value) => ({ fsPath: value }) };
export class ThemeIcon { constructor(id) { this.id = id; } }
export const window = { createTerminal: options => ({ options }), terminals: [] };
`;

interface Modules {
	readonly PtyBrokerClient: typeof PtyBrokerClientType;
	readonly attachRpcHost: typeof attachRpcHostType;
	readonly attachNativeHost: typeof attachNativeHostType;
	readonly probeRpcHost: typeof probeRpcHostType;
	readonly ptyPackagedTreeDigest: (extensionRoot: string) => Promise<string>;
}

const WINDOWS_ONLY = process.platform !== "win32" ? "the identity readings are implemented for Windows only" : false;

const ACCOUNT = "WORKSTATION\\dev";
const OWNER_ONLY = [ACCOUNT, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"];
const BROKER_CREATION = "133700000000000000";
const CHILD_CREATION = "133700000000000500";
const OTHER_CREATION = "133799999999999999";
const CHILD_PID = 4242;
const BROKER_PID = process.pid;

let temp: string;
let modules: Modules;
let extensionRoot: string;
let treeDigest: string;
const servers: PtyBrokerServer[] = [];

before(async () => {
	if (WINDOWS_ONLY !== false) return;
	temp = await mkdtemp(path.join(tmpdir(), "omp-attach-identity-"));
	const here = path.dirname(fileURLToPath(import.meta.url));
	const outfile = path.join(temp, "attach-identity.mjs");
	await build({
		stdin: {
			contents: [
				'export { PtyBrokerClient } from "./pty-client.ts";',
				'export { attachRpcHost } from "./rpc-launch.ts";',
				'export { attachNativeHost } from "./native-session.ts";',
				'export { probeRpcHost } from "./rpc-reconcile.ts";',
				'export { ptyPackagedTreeDigest } from "./pty-runtime.ts";',
			].join("\n"),
			resolveDir: here,
			sourcefile: "attach-identity-entry.ts",
			loader: "ts",
		},
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		plugins: [
			{
				name: "vscode-stub",
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
					pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: VSCODE_STUB, loader: "js" }));
				},
			},
		],
	});
	modules = (await import(pathToFileURL(outfile).href)) as Modules;
	// The packaged tree an attach hashes in place: three small files are enough to name a build.
	extensionRoot = path.join(temp, "extension");
	for (const [name, text] of [
		["pty-broker.js", "// entry"],
		["pty-process-probe.ps1", "# probe"],
		["pty-owner-watch.ps1", "# owner watch"],
	] as const) {
		await mkdir(path.join(extensionRoot, "out", "pty"), { recursive: true });
		await writeFile(path.join(extensionRoot, "out", "pty", name), text, "utf8");
	}
	treeDigest = await modules.ptyPackagedTreeDigest(extensionRoot);
});

after(async () => {
	for (const server of servers) await server.close();
	if (temp !== undefined) await rm(temp, { recursive: true, force: true });
});

function ownerOnlyProbe(): PrivateStorageProbe {
	return {
		platform: "win32",
		currentSid: TEST_CURRENT_SID,
		readAcl: async (): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: fixtureAcl(OWNER_ONLY.map(principal => `${principal}:(OI)(CI)(F)`)),
			detail: null,
		}),
		applyIcacls: async (): Promise<PrivateStorageCommandResult> => ({ ok: true, stdout: "", detail: null }),
		readOwners: async (paths: readonly string[]): Promise<PrivateStorageCommandResult> => ({
			ok: true,
			stdout: paths.map(target => `${target}|${fixturePrincipal(ACCOUNT)}`).join("\r\n"),
			detail: null,
		}),
	};
}

interface BrokerState {
	state: "running" | "exited";
	nativeCreationTime: string | null;
	attestation: PtyIdentityAttestation | undefined;
}

interface Fixture {
	readonly client: PtyBrokerClientType;
	readonly slot: string;
	readonly record: PtyBrokerRecord;
	readonly broker: BrokerState;
	/** Every pid the kernel reader was asked about, in order. */
	readonly readings: number[];
	/** What the kernel says about each pid. */
	readonly kernel: Map<number, PtyIdentityReading>;
	readonly storage: string;
	pin(overrides?: Partial<BrokerPin>): BrokerPin;
}

let counter = 0;

/** One recorded broker answering on loopback, plus a client whose kernel reader counts its calls. */
async function fixture(options: {
	readonly kind?: PtyKind;
	readonly attestation?: PtyIdentityAttestation;
	/** The creation time the broker proves for itself in its handshake; the record names `BROKER_CREATION`. */
	readonly brokerSays?: string;
	/**
	 * Hold every kernel reading until this many have been asked for: readings of one proof that run one
	 * after the other never reach it, so a regression to sequential reads stops the test at its timeout.
	 */
	readonly readBarrier?: number;
}): Promise<Fixture> {
	counter += 1;
	const kind = options.kind ?? "managed-rpc";
	const slot = `host:3f0f0f0f-0000-4000-8000-${String(counter).padStart(12, "0")}`;
	const storage = await mkdtemp(path.join(temp, "storage-"));
	const token = createPtyToken();
	const generation = createPtyGeneration();
	const brokerId = `pty-11111111-1111-4111-8111-${String(counter).padStart(12, "0")}`;
	const broker: BrokerState = {
		state: "running",
		nativeCreationTime: CHILD_CREATION,
		attestation: options.attestation,
	};
	const server = await startPtyBrokerServer({
		token,
		brokerId,
		generation,
		slot,
		kind,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest,
		brokerPid: BROKER_PID,
		brokerCreationTime: options.brokerSays ?? BROKER_CREATION,
	});
	servers.push(server);
	server.onConnection(connection => {
		connection.onFrame(frame => {
			if (frame.t !== "status") return;
			const status: PtyStatusPayload = {
				state: broker.state,
				exitCode: null,
				signal: null,
				cols: 80,
				rows: 24,
				alt: false,
				title: null,
				nativePid: CHILD_PID,
				nativeCreationTime: broker.nativeCreationTime,
				brokerPid: BROKER_PID,
				brokerCreationTime: BROKER_CREATION,
				clients: 1,
				inputOwner: null,
				uptimeMs: 1,
				noClientForMs: null,
				childExitedAtMs: null,
				outputPosition: 0,
				oldestPosition: 0,
				notices: [],
				ownerStop: { state: "not-applicable", detail: "a managed OMP host is never stopped by an owner watch", owners: [], graceRemainingMs: null },
				...(broker.attestation === undefined ? {} : { attestation: broker.attestation }),
			};
			connection.send({ v: PTY_PROTOCOL_VERSION, t: "status", id: frame.id, status });
		});
	});
	const record: PtyBrokerRecord = {
		version: PTY_RECORD_VERSION,
		service: PTY_SERVICE,
		protocolVersion: PTY_PROTOCOL_VERSION,
		runtimeVersion: PTY_RUNTIME_VERSION,
		treeDigest,
		brokerId,
		generation,
		slot,
		kind,
		port: server.port,
		token,
		brokerPid: BROKER_PID,
		brokerCreationTime: BROKER_CREATION,
		startedAt: new Date(0).toISOString(),
		cols: 80,
		rows: 24,
		title: null,
	};
	assert.equal((await claimPtyRecord(storage, record)).claimed, true);
	const readings: number[] = [];
	const kernel = new Map<number, PtyIdentityReading>([
		[BROKER_PID, { kind: "found", creationTime: BROKER_CREATION }],
		[CHILD_PID, { kind: "found", creationTime: CHILD_CREATION }],
	]);
	const barrier = Promise.withResolvers<void>();
	const client = new modules.PtyBrokerClient({
		storageDir: storage,
		extensionRoot,
		access: ownerOnlyProbe(),
		queryIdentity: async (_helper: PtyProbeHelper, pid: number) => {
			readings.push(pid);
			if (options.readBarrier === undefined || readings.length >= options.readBarrier) barrier.resolve();
			await barrier.promise;
			return kernel.get(pid) ?? { kind: "gone" };
		},
	});
	return {
		client,
		slot,
		record,
		broker,
		readings,
		kernel,
		storage,
		pin: (overrides = {}) => ({
			kind: "broker",
			slot,
			brokerId,
			brokerGeneration: generation,
			brokerPid: BROKER_PID,
			brokerCreationTime: BROKER_CREATION,
			nativePid: CHILD_PID,
			nativeCreationTime: CHILD_CREATION,
			...overrides,
		}),
	};
}

const ATTESTS_PIPE_CHILD: PtyIdentityAttestation = { brokerSelfRead: true, childHandleLive: true };
const ATTESTS_CONSOLE_CHILD: PtyIdentityAttestation = { brokerSelfRead: true, childHandleLive: false };

async function exists(target: string): Promise<boolean> {
	return await stat(target).then(() => true, () => false);
}

async function listenOnLoopback(server: net.Server): Promise<number> {
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	return (server.address() as net.AddressInfo).port;
}

async function closeServer(server: net.Server): Promise<void> {
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
}

describe("re-adopting a broker that attests its own identity", { skip: WINDOWS_ONLY }, () => {
	it("takes no kernel reading and never stages the probe helper", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual(f.readings, [], "an attested attach spawns no identity probe");
		assert.equal(outcome.timings?.brokerIdentity, "trusted");
		assert.equal(outcome.timings?.childIdentity, "trusted");
		assert.equal(await exists(path.join(f.storage, "runtime", "pty-probe")), false, "the helper is staged only when a reading is needed");
		outcome.runtime?.handle.disconnect();
	});

	it("proves the pair from the reconcile and the attach without any reading", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		const expected = { slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION };
		const probe = await modules.probeRpcHost({ client: f.client, slot: f.slot, expected });
		assert.equal(probe.kind, "attachable");
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual(f.readings, []);
		outcome.runtime?.handle.disconnect();
	});

	it("refuses a child the broker reports as exited, without a reading to excuse it", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		f.broker.state = "exited";
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "unavailable");
		assert.match(outcome.reason, /already exited/);
	});

	it("falls back to a kernel reading when the broker no longer holds its child's handle, and refuses the dead child it finds", async () => {
		const f = await fixture({ attestation: { brokerSelfRead: true, childHandleLive: false } });
		f.kernel.set(CHILD_PID, { kind: "gone" });
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "unavailable");
		assert.match(outcome.reason, /is gone/);
		assert.deepEqual(f.readings, [CHILD_PID], "only the child needed reading; the broker's own word stood");
	});

	it("refuses a child that is not the one the row pinned, even though the broker attests it", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		f.broker.nativeCreationTime = OTHER_CREATION;
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "unavailable");
		assert.match(outcome.reason, /changed since ownership was verified/);
		const expected = { slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION };
		assert.equal((await modules.probeRpcHost({ client: f.client, slot: f.slot, expected })).kind, "mismatch");
		assert.deepEqual(f.readings, []);
	});

	it("refuses a broker whose handshake names another creation time than its record, attested or not", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD, brokerSays: OTHER_CREATION });
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "unavailable");
		assert.match(outcome.reason, /different slot or process/);
		assert.deepEqual(f.readings, []);
	});

	it("refuses a record whose pid is no longer alive without opening a socket or reading anything", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		const stale = { ...f.record, brokerPid: 2147483000 };
		const outcome = await f.client.attachRpcRecord(stale, { adopted: true });
		assert.equal(outcome.state, "unavailable");
		assert.match(outcome.reason, /is gone/);
		assert.deepEqual(f.readings, []);
	});

	describe("a record whose broker pid now names a live process (the reboot case)", () => {
		// `process.pid` is alive, so the coarse liveness check cannot refuse: only the handshake can.
		const staleRecord = (f: Fixture, port: number) => ({ ...f.record, brokerPid: process.pid, port });

		it("is refused when nothing listens on the recorded port", async () => {
			const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
			const parked = net.createServer();
			const closedPort = await listenOnLoopback(parked);
			await closeServer(parked);
			const outcome = await f.client.attachRpcRecord(staleRecord(f, closedPort), { adopted: true });
			assert.equal(outcome.state, "unavailable");
			assert.equal(outcome.handle, null);
			assert.deepEqual(f.readings, [], "no PowerShell reading was needed to refuse it");
		});

		it("is refused when another broker answers on the recorded port", async () => {
			const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
			const stranger = await fixture({ attestation: ATTESTS_PIPE_CHILD });
			const outcome = await f.client.attachRpcRecord(staleRecord(f, stranger.record.port), { adopted: true });
			assert.equal(outcome.state, "unavailable", "its token is not this record's, so it cannot prove the record's broker");
			assert.equal(outcome.handle, null);
			assert.deepEqual(f.readings, []);
		});

		it("is refused when a listener that does not hold the token answers", async () => {
			const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
			const sockets: net.Socket[] = [];
			const impostor = net.createServer(socket => {
				sockets.push(socket);
				socket.on("error", () => {});
				socket.end('{"v":1,"t":"hello-ok","mac":"not a mac"}\n');
			});
			const port = await listenOnLoopback(impostor);
			try {
				const outcome = await f.client.attachRpcRecord(staleRecord(f, port), { adopted: true });
				assert.equal(outcome.state, "unavailable");
				assert.equal(outcome.handle, null);
				assert.deepEqual(f.readings, []);
			} finally {
				for (const socket of sockets) socket.destroy();
				await closeServer(impostor);
			}
		});
	});
});

describe("the state-directory access verification", { skip: WINDOWS_ONLY }, () => {
	function gatedClient(f: Fixture, verdict: { readonly open: boolean }): {
		readonly client: PtyBrokerClientType;
		readonly aclReads: string[];
		/** Resolves when the verification has asked for its first ACL. */
		readonly started: Promise<void>;
		release(): void;
	} {
		const aclReads: string[] = [];
		let release: () => void = () => {};
		let begin: () => void = () => {};
		const gate = new Promise<void>(resolve => { release = resolve; });
		const started = new Promise<void>(resolve => { begin = resolve; });
		const probe = ownerOnlyProbe();
		const client = new modules.PtyBrokerClient({
			storageDir: f.storage,
			extensionRoot,
			access: {
				...probe,
				readAcl: async (target: string) => {
					aclReads.push(target);
					begin();
					await gate;
					return verdict.open
						? { ok: true, stdout: fixtureAcl(["Everyone:(OI)(CI)(F)"]), detail: null }
						: await probe.readAcl!(target);
				},
			},
			queryIdentity: async () => ({ kind: "gone" }),
		});
		return { client, aclReads, started, release };
	}

	it("started ahead of the first attach is the verification that attach waits for, and runs once", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		const { client, aclReads, started, release } = gatedClient(f, { open: false });
		const events: string[] = [];
		const warm = client.stateAccess();
		await started;

		const attach = modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client }).then(outcome => {
			events.push("attach finished");
			return outcome;
		});
		events.push("verification released");
		release();
		assert.equal((await warm).ok, true);
		const readsByVerification = aclReads.length;
		const outcome = await attach;
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual(events, ["verification released", "attach finished"], "an attach never gets ahead of the verification");
		assert.equal(aclReads.length, readsByVerification, "the attach shared the warm verification instead of repeating it");
		outcome.runtime?.handle.disconnect();
	});

	it("that refuses the directory refuses the attach it was warmed for", async () => {
		const f = await fixture({ attestation: ATTESTS_PIPE_CHILD });
		const { client, release } = gatedClient(f, { open: true });
		const warm = client.stateAccess();
		release();
		assert.equal((await warm).ok, false);
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client });
		assert.notEqual(outcome.state, "attached");
		assert.match(outcome.reason, /state directory is not usable/);
	});
});

/** Process ids in a fixed order: the two readings of one proof run together, so their order is not part of what a test asserts. */
function pids(values: readonly number[]): number[] {
	return [...values].sort((a, b) => a - b);
}

describe("re-adopting a broker that attests nothing (an older build's)", { skip: WINDOWS_ONLY }, () => {
	it("falls back to one reading of the broker and one of its child", async () => {
		const f = await fixture({});
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual(pids(f.readings), pids([BROKER_PID, CHILD_PID]), "one reading of the broker and one of its child; their order is not part of the proof");
		assert.equal(outcome.timings?.brokerIdentity, "probe");
		assert.equal(outcome.timings?.childIdentity, "probe");
		outcome.runtime?.handle.disconnect();
	});

	it("reads the kernel again for the attach that follows a reconcile", async () => {
		const f = await fixture({});
		const expected = { slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION };
		const probe = await modules.probeRpcHost({ client: f.client, slot: f.slot, expected });
		assert.equal(probe.kind, "attachable");
		assert.deepEqual(pids(f.readings), pids([BROKER_PID, CHILD_PID]));
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual([pids(f.readings.slice(0, 2)), pids(f.readings.slice(2))], [pids([BROKER_PID, CHILD_PID]), pids([BROKER_PID, CHILD_PID])], "the attach proves the pair on its own readings: nothing from the reconcile is kept");
		outcome.runtime?.handle.disconnect();
	});

	it("reads the broker and its child together inside one attach proof", { timeout: 20_000 }, async () => {
		const f = await fixture({ readBarrier: 2 });
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual(pids(f.readings), pids([BROKER_PID, CHILD_PID]));
		outcome.runtime?.handle.disconnect();
	});

	it("reads the broker and its child together inside one reconcile proof", { timeout: 20_000 }, async () => {
		const f = await fixture({ readBarrier: 2 });
		const expected = { slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION };
		const probe = await modules.probeRpcHost({ client: f.client, slot: f.slot, expected });
		assert.equal(probe.kind, "attachable");
		assert.deepEqual(pids(f.readings), pids([BROKER_PID, CHILD_PID]));
	});

	it("still refuses when either concurrent reading fails, and names the broker's failure first", { timeout: 20_000 }, async () => {
		const brokerUnreadable = await fixture({ readBarrier: 2 });
		brokerUnreadable.kernel.set(BROKER_PID, { kind: "unknown", detail: "the probe printed stderr" });
		const refusedBroker = await modules.attachRpcHost({ pin: brokerUnreadable.pin(), cwd: temp, sessionFile: null, client: brokerUnreadable.client });
		assert.equal(refusedBroker.state, "unavailable");
		assert.match(refusedBroker.reason, /could not be identified/);
		assert.deepEqual(pids(brokerUnreadable.readings), pids([BROKER_PID, CHILD_PID]), "the child's reading was in flight too");

		const childReused = await fixture({ readBarrier: 2 });
		childReused.kernel.set(CHILD_PID, { kind: "found", creationTime: OTHER_CREATION });
		const refusedChild = await modules.attachRpcHost({ pin: childReused.pin(), cwd: temp, sessionFile: null, client: childReused.client });
		assert.equal(refusedChild.state, "unavailable");
		assert.match(refusedChild.reason, /creation time does not match/);

		const both = await fixture({ readBarrier: 2 });
		both.kernel.set(BROKER_PID, { kind: "gone" });
		both.kernel.set(CHILD_PID, { kind: "gone" });
		const refusedBoth = await modules.attachRpcHost({ pin: both.pin(), cwd: temp, sessionFile: null, client: both.client });
		assert.equal(refusedBoth.state, "unavailable");
		assert.match(refusedBoth.reason, /recorded broker process \d+ is gone/, "the broker's reason, as when the readings were taken one after the other");

		const expected = (f: Fixture) => ({ slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION });
		const probedChild = await fixture({ readBarrier: 2 });
		probedChild.kernel.set(CHILD_PID, { kind: "unknown", detail: "the probe printed stderr" });
		assert.equal((await modules.probeRpcHost({ client: probedChild.client, slot: probedChild.slot, expected: expected(probedChild) })).kind, "unreachable");
		const probedBroker = await fixture({ readBarrier: 2 });
		probedBroker.kernel.set(BROKER_PID, { kind: "gone" });
		assert.equal((await modules.probeRpcHost({ client: probedBroker.client, slot: probedBroker.slot, expected: expected(probedBroker) })).kind, "unreachable");
	});

	it("refuses a pid that now belongs to another process, a dead child and an unreadable one", async () => {
		const reused = await fixture({});
		reused.kernel.set(BROKER_PID, { kind: "found", creationTime: OTHER_CREATION });
		const refusedBroker = await modules.attachRpcHost({ pin: reused.pin(), cwd: temp, sessionFile: null, client: reused.client });
		assert.equal(refusedBroker.state, "unavailable");
		assert.match(refusedBroker.reason, /creation time does not match/);

		const dead = await fixture({});
		dead.kernel.set(CHILD_PID, { kind: "gone" });
		const refusedChild = await modules.attachRpcHost({ pin: dead.pin(), cwd: temp, sessionFile: null, client: dead.client });
		assert.equal(refusedChild.state, "unavailable");
		assert.match(refusedChild.reason, /is gone/);

		const unreadable = await fixture({});
		unreadable.kernel.set(CHILD_PID, { kind: "unknown", detail: "the probe printed stderr" });
		const refusedUnknown = await modules.attachRpcHost({ pin: unreadable.pin(), cwd: temp, sessionFile: null, client: unreadable.client });
		assert.equal(refusedUnknown.state, "unavailable");
		assert.doesNotMatch(refusedUnknown.reason, /stderr/);
	});

	it("judges a pid that changed hands between the reconcile and the attach on the reading taken for the attach", async () => {
		const f = await fixture({});
		const expected = { slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION };
		assert.equal((await modules.probeRpcHost({ client: f.client, slot: f.slot, expected })).kind, "attachable");
		// The child ended and its pid went to another process after the reconcile had read it.
		f.kernel.set(CHILD_PID, { kind: "found", creationTime: OTHER_CREATION });
		const outcome = await modules.attachRpcHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "unavailable", "a kept reading would have admitted the dead child");
		assert.match(outcome.reason, /creation time does not match/);

		// And the other way: a reading of another process refuses one proof and does not stick to the next.
		const other = await fixture({});
		const otherExpected = { ...expected, slot: other.slot, brokerId: other.record.brokerId, brokerGeneration: other.record.generation };
		other.kernel.set(CHILD_PID, { kind: "found", creationTime: OTHER_CREATION });
		assert.equal((await modules.probeRpcHost({ client: other.client, slot: other.slot, expected: otherExpected })).kind, "unreachable");
		other.kernel.set(CHILD_PID, { kind: "found", creationTime: CHILD_CREATION });
		assert.equal((await modules.probeRpcHost({ client: other.client, slot: other.slot, expected: otherExpected })).kind, "attachable", "the next proof reads the kernel again");
	});
});

describe("re-adopting a native Terminal broker", { skip: WINDOWS_ONLY }, () => {
	it("believes the broker about itself but reads its pseudo-console child for the reconcile and again for the attach", async () => {
		const f = await fixture({ kind: "managed-omp", attestation: ATTESTS_CONSOLE_CHILD });
		const expected = { slot: f.slot, brokerId: f.record.brokerId, brokerGeneration: f.record.generation, brokerPid: BROKER_PID, brokerCreationTime: BROKER_CREATION, childPid: CHILD_PID, childCreationTime: CHILD_CREATION };
		const probe = await modules.probeRpcHost({ client: f.client, slot: f.slot, expected, kind: "managed-omp" });
		assert.equal(probe.kind, "attachable");
		assert.deepEqual(f.readings, [CHILD_PID], "the broker's pid is not read; its pseudo-console child is");
		const outcome = await modules.attachNativeHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "attached", outcome.reason);
		assert.deepEqual(f.readings, [CHILD_PID, CHILD_PID], "two readings per native row, not four");
		assert.equal(outcome.timings?.brokerIdentity, "trusted");
		outcome.runtime?.handle.disconnect();
	});

	it("refuses a pseudo-console child the kernel no longer has", async () => {
		const f = await fixture({ kind: "managed-omp", attestation: ATTESTS_CONSOLE_CHILD });
		f.kernel.set(CHILD_PID, { kind: "gone" });
		const outcome = await modules.attachNativeHost({ pin: f.pin(), cwd: temp, sessionFile: null, client: f.client });
		assert.equal(outcome.state, "unavailable");
		assert.match(outcome.reason, /is gone/);
	});
});
