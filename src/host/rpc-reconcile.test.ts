/**
 * Tests for what this window can prove about the writer of a session row, from the broker.
 *
 * The module imports its siblings without file extensions (the way esbuild resolves
 * them), so it is compiled here with the project's own bundler and driven through its
 * exports. What is worth defending:
 *
 * - a probe proves the *recorded pair* — broker generation and child pid plus kernel
 *   creation time — and answers a bounded reason authored here, never a broker's,
 *   helper's or parser's own text;
 * - `free` is only ever answered with evidence the index re-validates: the broker
 *   reporting the recorded child exited, or the recorded broker **and** child both
 *   read as gone; every reading that cannot be made is `unknown`, never absence;
 * - a stop reaches only the exact child the row recorded, reports what it proved, and
 *   closes every attachment it opened.
 *
 * Runner: `node --test src/host/rpc-reconcile.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { createClaimHolder } from "./session-claim.ts";
import { SessionIndex } from "./session-index.ts";
import type {
	AttachedBrokerHandle,
	BrokerPin,
	createOwnerReconciler as createOwnerReconcilerType,
	decideStop as decideStopType,
	NativeGenerationReader,
	OwnerReconcilePorts,
	probeBrokerSlotForRunningChild as probeBrokerSlotForRunningChildType,
	probeRpcHost as probeRpcHostType,
	provedBrokerPin as provedBrokerPinType,
	RpcProbeResult,
	stopBrokerOwnedHost as stopBrokerOwnedHostType,
	verifyPinnedBrokerAttachment as verifyPinnedBrokerAttachmentType,
} from "./rpc-reconcile.ts";
import type { OmpHostHandle, OmpHostLauncher, OwnerReconcileRequest, RecordedHost, RecordedRpcIdentity, SessionIndexEntry, SessionIndexStore } from "./session-index.ts";
import type { PtyBrokerRecord, PtyStopResult } from "./pty-protocol.ts";

/** The part of the compiled module these tests drive. */
interface RpcReconcileModule {
	readonly createOwnerReconciler: typeof createOwnerReconcilerType;
	readonly decideStop: typeof decideStopType;
	readonly probeBrokerSlotForRunningChild: typeof probeBrokerSlotForRunningChildType;
	readonly probeRpcHost: typeof probeRpcHostType;
	readonly provedBrokerPin: typeof provedBrokerPinType;
	readonly stopBrokerOwnedHost: typeof stopBrokerOwnedHostType;
	readonly verifyPinnedBrokerAttachment: typeof verifyPinnedBrokerAttachmentType;
}

let reconcile: RpcReconcileModule;
let temp: string;

before(async () => {
	temp = await mkdtemp(path.join(tmpdir(), "omp-rpc-reconcile-"));
	const outfile = path.join(temp, "rpc-reconcile.mjs");
	await build({
		entryPoints: [fileURLToPath(new URL("./rpc-reconcile.ts", import.meta.url))],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
	});
	// The specifier is the bundle just written, so it cannot be a static import.
	reconcile = (await import(pathToFileURL(outfile).href)) as RpcReconcileModule;
});

after(async () => {
	await rm(temp, { recursive: true, force: true });
});

/** The broker's own creation time, and the OMP child's: distinct, so neither can stand in for the other. */
const BROKER_CREATION = "133700000000000000";
const CHILD_CREATION = "133700000000000500";
/** The durable slot the recorded `managed-rpc` child runs under. */
const SLOT = "host:3f0f0f0f-0000-4000-8000-000000000001";
const BROKER_ID = "pty-11111111-1111-4111-8111-111111111111";
const BROKER_GENERATION = "gen-22222222-2222-4222-8222-222222222222";
const CHILD_PID = 4242;
const BROKER_PID = 77;
const HOST_CWD = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";

const RPC_IDENTITY: RecordedRpcIdentity = {
	slot: SLOT,
	brokerId: BROKER_ID,
	brokerGeneration: BROKER_GENERATION,
	brokerPid: BROKER_PID,
	brokerCreationTime: BROKER_CREATION,
	childPid: CHILD_PID,
	childCreationTime: CHILD_CREATION,
};

/** The host one row of this build recorded: the child its own launch outcome proved. */
const RECORDED_RPC_HOST: RecordedHost = {
	pid: CHILD_PID,
	instanceId: null,
	generation: null,
	sessionId: "S-ONE",
	startedAt: "2026-09-27T10:00:00.000Z",
	transport: "rpc",
	rpc: RPC_IDENTITY,
};

/** A launch of an earlier build: no rpc transport, only a pid and its own Collab-era identity. */
const LEGACY_HOST: RecordedHost = {
	pid: CHILD_PID,
	instanceId: "host-1",
	generation: 3,
	sessionId: "S-ONE",
	startedAt: "2026-09-27T10:00:00.000Z",
};

/** The attempt an interrupted window left behind: an rpc launch whose outcome was never read. */
const UNIDENTIFIED: RecordedHost = {
	pid: null,
	instanceId: null,
	generation: null,
	sessionId: "S-ONE",
	startedAt: "2026-09-27T10:00:00.000Z",
	transport: "rpc",
	rpc: null,
};

/** One recorded row's index entry, as the reconciler receives it. */
function reconcilableEntry(host: RecordedHost | null): SessionIndexEntry {
	return {
		tabId: "tab:one",
		kind: "session",
		origin: "extension",
		sessionFile: null,
		sessionId: "S-ONE",
		cwd: HOST_CWD,
		scope: { profile: null, sessionDir: null },
		sessionDir: null,
		ownership: { ownerGeneration: "gen-1", draftIdentity: null, releasedAt: null },
		host,
		createdAt: "2026-09-27T10:00:00.000Z",
		lastActiveAt: "2026-09-27T10:00:00.000Z",
		ordinal: 0,
		availability: "saved",
		detail: null,
		runIntent: "running",
		title: null,
		lastCompletedReplyId: null,
		lastSeenReplyId: null,
	};
}

function reconcileRequest(host: RecordedHost | null = RECORDED_RPC_HOST): OwnerReconcileRequest {
	return {
		entry: reconcilableEntry(host),
		sessionFile: null,
		draftIdentity: null,
		ownerGeneration: "gen-1",
		claim: null,
		host,
	};
}

/** The pin one successful broker probe proves for the fixture row. */
function brokerPin(overrides: Partial<BrokerPin> = {}): BrokerPin {
	return {
		kind: "broker",
		slot: SLOT,
		brokerId: BROKER_ID,
		brokerGeneration: BROKER_GENERATION,
		brokerPid: BROKER_PID,
		brokerCreationTime: BROKER_CREATION,
		nativePid: CHILD_PID,
		nativeCreationTime: CHILD_CREATION,
		...overrides,
	};
}

function brokerRecord(overrides: Partial<PtyBrokerRecord> = {}): PtyBrokerRecord {
	return {
		version: 1,
		service: "omp-vscode-pty",
		protocolVersion: 2,
		runtimeVersion: 2,
		treeDigest: "a".repeat(64),
		brokerId: BROKER_ID,
		generation: BROKER_GENERATION,
		slot: SLOT,
		kind: "managed-rpc",
		port: 41234,
		token: "t".repeat(43),
		brokerPid: BROKER_PID,
		brokerCreationTime: BROKER_CREATION,
		startedAt: "2026-09-27T10:00:00.000Z",
		cols: 80,
		rows: 24,
		title: null,
		...overrides,
	};
}

/** The live facts one attached handle answers, with no broker involved. */
function attachedHandle(overrides: Partial<AttachedBrokerHandle> = {}): AttachedBrokerHandle {
	return {
		slot: SLOT,
		kind: "managed-rpc",
		brokerPid: BROKER_PID,
		record: brokerRecord(),
		nativePid: CHILD_PID,
		nativeCreationTime: CHILD_CREATION,
		state: "running",
		...overrides,
	};
}

/** The kernel reader one verified attachment uses: the recorded child's own time. */
const readsRecordedChild: NativeGenerationReader = async () => ({ kind: "found", creationTime: CHILD_CREATION });

type Client = Parameters<typeof reconcile.probeRpcHost>[0]["client"];

/**
 * A broker client stub answering the two questions a read-only probe asks: the slot's
 * record, and an authenticated attachment for it. The record's own kind picks which
 * attach the module calls, so both answer the same handle.
 */
function brokerClient(input: {
	readonly record?: unknown;
	readonly handle?: unknown;
	readonly onDisconnect?: () => void;
} = {}): Client {
	const attach = async () => ({
		state: input.handle === null ? "unavailable" : "attached",
		reason: "the handshake said: bad-mac 1234",
		handle:
			input.handle !== undefined
				? input.handle
				: { ...attachedHandle(), disconnect: () => input.onDisconnect?.() },
	});
	return {
		readRecord: async () => input.record ?? { kind: "ok", record: brokerRecord() },
		attachRpcRecord: attach,
		attachRecord: attach,
	} as unknown as Client;
}

describe("stop verdict", () => {
	const base = {
		pidGone: true,
		treeEmpty: true,
		nativePid: CHILD_PID,
		remaining: [] as readonly number[],
		brokerDetail: "the broker reported the child gone",
	};

	it("reports the writer gone with the broker's own verified verdict when the tree is proven empty", () => {
		const verdict = reconcile.decideStop(base);
		assert.equal(verdict.writerGone, true);
		assert.equal(verdict.treeEmpty, true);
		assert.equal(verdict.diagnosticDetail, base.brokerDetail);
	});

	it("keeps the writer while the process is not proven gone", () => {
		const verdict = reconcile.decideStop({ ...base, pidGone: false, treeEmpty: false });
		assert.equal(verdict.writerGone, false);
		assert.equal(verdict.treeEmpty, false);
		assert.doesNotMatch(verdict.detail, /pid|broker|claim|writer/);
	});

	it("reports an unprovable tree separately from the writer being gone", () => {
		const verdict = reconcile.decideStop({ ...base, treeEmpty: false, remaining: [777] });
		assert.equal(verdict.writerGone, true);
		assert.equal(verdict.treeEmpty, false);
		assert.doesNotMatch(verdict.detail, /777|pid|broker|claim|writer/);
		assert.match(verdict.diagnosticDetail!, /777/);
	});
});

describe("broker attachment proof", () => {
	it("proves a running managed child whose kernel generation still matches", async () => {
		const proof = await reconcile.provedBrokerPin(attachedHandle(), readsRecordedChild);
		assert.deepEqual(proof, { ok: true, pin: brokerPin() });

		const pinned = await reconcile.verifyPinnedBrokerAttachment({
			handle: attachedHandle(),
			pin: brokerPin(),
			readNativeGeneration: readsRecordedChild,
		});
		assert.deepEqual(pinned, { ok: true });
	});

	it("refuses anything but a running child of the kind and slot the row recorded", async () => {
		const cases: Array<{ readonly handle: AttachedBrokerHandle; readonly expected: RegExp }> = [
			{ handle: attachedHandle({ kind: "folder-shell" }), expected: /not the kind of session host/ },
			// A legacy slot is never adopted as an rpc child.
			{ handle: attachedHandle({ kind: "managed-omp" }), expected: /not the kind of session host/ },
			{ handle: attachedHandle({ state: "exited" }), expected: /already exited/ },
			{ handle: attachedHandle({ nativePid: null }), expected: /no child process id/ },
			{ handle: attachedHandle({ nativeCreationTime: null }), expected: /reused one/ },
			{
				handle: attachedHandle({ record: brokerRecord({ slot: "host:00000000-0000-4000-8000-000000000009" }) }),
				expected: /different slot/,
			},
		];
		for (const { handle, expected } of cases) {
			const proof = await reconcile.provedBrokerPin(handle, readsRecordedChild);
			assert.equal(proof.ok, false, `expected a refusal for ${expected}`);
			assert.match(proof.ok ? "" : proof.reason, expected);
		}
	});

	it("proves a legacy managed child only when asked for that kind", async () => {
		const legacy = attachedHandle({ kind: "managed-omp", record: brokerRecord({ kind: "managed-omp" }) });
		assert.equal((await reconcile.provedBrokerPin(legacy, readsRecordedChild, "managed-omp")).ok, true);
	});

	it("refuses a child the kernel no longer reads as that generation", async () => {
		const reused = await reconcile.provedBrokerPin(attachedHandle(), async () => ({
			kind: "found",
			creationTime: "133799999999999999",
		}));
		assert.equal(reused.ok, false);
		assert.match(reused.ok ? "" : reused.reason, /creation time does not match/);

		const gone = await reconcile.provedBrokerPin(attachedHandle(), async () => ({ kind: "gone" }));
		assert.match(gone.ok ? "" : gone.reason, /is gone/);

		const unreadable = await reconcile.provedBrokerPin(attachedHandle(), async () => ({
			kind: "unknown",
			detail: "the helper printed stderr",
		}));
		assert.match(unreadable.ok ? "" : unreadable.reason, /could not be identified/);
		assert.doesNotMatch(
			unreadable.ok ? "" : unreadable.reason,
			/stderr/,
			"a helper's own text never reaches an ownership reason",
		);
	});

	it("refuses a target that changed between the verdict and the attach", async () => {
		const changed = await reconcile.verifyPinnedBrokerAttachment({
			handle: attachedHandle(),
			pin: brokerPin({ nativeCreationTime: "133711111111111111" }),
			readNativeGeneration: readsRecordedChild,
		});
		assert.equal(changed.ok, false);
		assert.match(changed.ok ? "" : changed.reason, /changed since ownership was verified/);
	});
});

describe("probe of a recorded rpc host", () => {
	function probe(client: Client, overrides: { readonly expected?: RecordedRpcIdentity; readonly reader?: NativeGenerationReader } = {}) {
		return reconcile.probeRpcHost({
			client,
			slot: SLOT,
			expected: overrides.expected ?? RPC_IDENTITY,
			readNativeGeneration: overrides.reader ?? readsRecordedChild,
		});
	}

	it("proves the recorded pair is still running, and disconnects before it answers", async () => {
		let disconnected = 0;
		const result = await probe(brokerClient({ onDisconnect: () => (disconnected += 1) }));

		assert.deepEqual(result, { kind: "attachable", pin: brokerPin() });
		assert.equal(disconnected, 1, "a probe closes the connection it opened");
	});

	it("reports the recorded child exited only for that exact child", async () => {
		const exited = await probe(
			brokerClient({ handle: { ...attachedHandle({ state: "exited" }), disconnect: () => undefined } }),
		);
		assert.deepEqual(exited, { kind: "child-exited", childPid: CHILD_PID, brokerGeneration: BROKER_GENERATION });

		// Another exited child under the same slot is not the recorded child's absence.
		const other = await probe(
			brokerClient({
				handle: { ...attachedHandle({ state: "exited", nativePid: CHILD_PID + 1 }), disconnect: () => undefined },
			}),
		);
		assert.equal(other.kind, "mismatch");
	});

	it("refuses a slot that now names another launch, another kind or another child", async () => {
		const cases: Array<{ readonly name: string; readonly handle: AttachedBrokerHandle }> = [
			{
				name: "another broker",
				handle: attachedHandle({ record: brokerRecord({ brokerId: "pty-99999999-9999-4999-8999-999999999999" }) }),
			},
			{
				name: "another generation",
				handle: attachedHandle({ record: brokerRecord({ generation: "gen-other" }) }),
			},
			{
				name: "a native host where this row recorded RPC",
				handle: attachedHandle({ kind: "managed-omp", record: brokerRecord({ kind: "managed-omp" }) }),
			},
			{
				name: "another child",
				handle: attachedHandle({ nativePid: CHILD_PID + 1 }),
			},
			{
				name: "a child created at another time",
				handle: attachedHandle({ nativeCreationTime: "133799999999999999" }),
			},
		];
		for (const { name, handle } of cases) {
			const result = await probe(brokerClient({ handle: { ...handle, disconnect: () => undefined } }), {
				reader: async () => ({ kind: "found", creationTime: handle.nativeCreationTime ?? CHILD_CREATION }),
			});
			assert.equal(result.kind, "mismatch", name);
		}
	});

	it("is unreachable, never a mismatch or an absence, when the child cannot be proven", async () => {
		// The broker says running, the kernel reads another creation time: a reused pid.
		const reused = await probe(brokerClient(), { reader: async () => ({ kind: "found", creationTime: "133799999999999999" }) });
		assert.equal(reused.kind, "unreachable");
		assert.match(reused.kind === "unreachable" ? reused.reason : "", /creation time does not match/);

		const unread = await probe(brokerClient(), {
			reader: async () => ({ kind: "unknown", detail: "the helper printed stderr" }),
		});
		assert.equal(unread.kind, "unreachable");
	});

	it("answers no-record for an absent record and a bounded reason for a record it cannot use", async () => {
		assert.deepEqual(await probe(brokerClient({ record: { kind: "none" } })), { kind: "no-record" });

		const cases: Array<{ readonly client: Client; readonly expected: RegExp }> = [
			{ client: brokerClient({ record: { kind: "invalid", detail: "malformed json at byte 3" } }), expected: /could not be read/ },
			{ client: brokerClient({ handle: null }), expected: /could not be authenticated/ },
			{
				client: brokerClient({ record: { kind: "ok", record: brokerRecord({ slot: "host:other-slot" }) } }),
				expected: /names a different slot/,
			},
		];
		for (const { client, expected } of cases) {
			const result: RpcProbeResult = await probe(client);
			assert.equal(result.kind, "unreachable", `expected a refusal for ${expected}`);
			assert.match(result.kind === "unreachable" ? result.reason : "", expected);
			assert.doesNotMatch(
				result.kind === "unreachable" ? result.reason : "",
				/bad-mac|1234|byte 3/,
				"no broker or parser text is forwarded through this path",
			);
		}
	});

	it("refuses an attachment that proves another slot than the one asked, and still closes it", async () => {
		let disconnected = 0;
		const result = await probe(
			brokerClient({
				handle: { ...attachedHandle({ slot: "host:other-slot" }), disconnect: () => (disconnected += 1) },
			}),
		);
		assert.equal(result.kind, "unreachable");
		assert.match(result.kind === "unreachable" ? result.reason : "", /different slot/);
		assert.equal(disconnected, 1);
	});

	it("reattaches the exact writer while an equivalent ownership probe is in flight", async () => {
		const cwd = path.join(temp, "capacity-project");
		const claimStorageDir = path.join(temp, "capacity-claims");
		await Promise.all([mkdir(cwd), mkdir(claimStorageDir)]);
		const file = path.join(temp, "capacity-session.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session_title", v: 1, title: "", updatedAt: "2026-09-27T10:00:00.000Z" }).padEnd(255, " ")}\n${JSON.stringify({ type: "session", version: 3, id: "S-ONE", timestamp: "2026-09-27T10:00:00.000Z", cwd })}\n`);
		const values = new Map<string, unknown>();
		const store: SessionIndexStore = {
			get: <T>(key: string) => values.get(key) as T | undefined,
			update: async (key, value) => { values.set(key, value); },
		};
		const original: OmpHostHandle = { pid: CHILD_PID, sessionId: "S-ONE", rpc: RPC_IDENTITY };
		const previous = new SessionIndex({ store, claimStorageDir, claimHolder: createClaimHolder(4194303) });
		const draft = await previous.createDraft({ cwd });
		await previous.promoteDraft(draft.tabId, file);
		await previous.closeSession(draft.tabId, { confirmedStopped: true });
		await previous.setRunIntent(draft.tabId, "running");
		await previous.restore(draft.tabId, {
			reconciler: { reconcile: async () => ({ kind: "free", evidence: [{ kind: "no-recorded-host" }] }) },
			launcher: {
				launch: async () => ({ state: "running", host: original }),
				attach: async () => ({ state: "unavailable", reason: "the initial fixture has no surviving host" }),
			},
		});
		const index = new SessionIndex({ store, claimStorageDir });
		const childIdentity = Promise.withResolvers<Awaited<ReturnType<NativeGenerationReader>>>();
		const readingChild = Promise.withResolvers<void>();
		const openingProbe = Promise.withResolvers<void>();
		const reader: NativeGenerationReader = async () => {
			readingChild.resolve();
			return await childIdentity.promise;
		};
		let activeConnections = 0;
		const client = {
			readRecord: async () => ({ kind: "ok", record: brokerRecord() }),
			attachRpcRecord: async () => {
				if (activeConnections > 0) return { state: "unavailable", reason: "the broker refused the connection: busy", handle: null };
				activeConnections++;
				return { state: "attached", reason: "attached", handle: { ...attachedHandle(), disconnect: () => { activeConnections--; } } };
			},
		} as unknown as Client;
		const owner = reconcile.createOwnerReconciler(reconcilePorts({
			readProcessIdentity: async pid => ({ kind: "found", creationTime: pid === BROKER_PID ? BROKER_CREATION : CHILD_CREATION }),
			probeRpc: async (slot, expected, kind) => {
				const pending = reconcile.probeRpcHost({
					client,
					slot,
					expected,
					...(kind === undefined ? {} : { kind }),
					readNativeGeneration: reader,
				});
				await new Promise<void>(resolve => setImmediate(resolve));
				openingProbe.resolve();
				return await pending;
			},
		}));
		let launches = 0;
		const attached: number[] = [];
		const launcher: OmpHostLauncher = {
			launch: async () => {
				launches++;
				return { state: "running", host: { ...original, pid: CHILD_PID + 1 } };
			},
			attach: async request => {
				attached.push(request.recordedHost.pid!);
				return { state: "attached", host: original };
			},
		};
		const background = probe(client, { reader });
		try {
			await readingChild.promise;
			const opening = index.restore(draft.tabId, { reconciler: owner, launcher });
			await openingProbe.promise;
			childIdentity.resolve({ kind: "found", creationTime: CHILD_CREATION });
			const outcome = await opening;
			await background;
			assert.equal(outcome.status, "attached", "an overlapping Sessions proof must not make a live writer startable");
			assert.equal(launches, 0, "ordinary Open must never create a second writer");
			assert.deepEqual(attached, [CHILD_PID]);
			assert.equal(index.get(draft.tabId)?.host?.pid, CHILD_PID);
			assert.deepEqual(index.get(draft.tabId)?.host?.rpc, RPC_IDENTITY);
		} finally {
			childIdentity.resolve({ kind: "found", creationTime: CHILD_CREATION });
			await background;
		}
	});

	it("does not borrow an in-flight proof for another launch, child, kernel reader, client or transport", async () => {
		const readingChild = Promise.withResolvers<void>();
		const identity = Promise.withResolvers<Awaited<ReturnType<NativeGenerationReader>>>();
		const reader: NativeGenerationReader = async () => {
			readingChild.resolve();
			return await identity.promise;
		};
		const client = brokerClient();
		const current = probe(client, { reader });
		await readingChild.promise;
		const otherLaunch = probe(client, { expected: { ...RPC_IDENTITY, brokerGeneration: "gen-other" }, reader });
		const otherChild = probe(client, { expected: { ...RPC_IDENTITY, childPid: CHILD_PID + 1 }, reader });
		const unreadable = probe(client, { reader: async () => ({ kind: "unknown", detail: "kernel unavailable" }) });
		const otherClient = probe(
			brokerClient({ handle: { ...attachedHandle({ state: "exited" }), disconnect: () => undefined } }),
			{ reader },
		);
		const native = reconcile.probeRpcHost({
			client, slot: SLOT, expected: RPC_IDENTITY, kind: "managed-omp", readNativeGeneration: reader,
		});
		identity.resolve({ kind: "found", creationTime: CHILD_CREATION });
		const [live, launch, child, unknown, exited, transport] = await Promise.all([
			current, otherLaunch, otherChild, unreadable, otherClient, native,
		]);
		assert.equal(live.kind, "attachable");
		assert.equal(launch.kind, "mismatch", "another broker generation needs its own proof");
		assert.equal(child.kind, "mismatch", "another recorded child needs its own proof");
		assert.equal(unknown.kind, "unreachable", "a different kernel reader must not inherit a positive verdict");
		assert.equal(exited.kind, "child-exited", "another client must observe its own broker");
		assert.equal(transport.kind, "mismatch", "Native must not inherit a Chat ownership proof");
	});

	it("reads the child again after a settled ownership proof", async () => {
		const handle = { ...attachedHandle(), disconnect: () => undefined };
		const client = brokerClient({ handle });
		assert.equal((await probe(client)).kind, "attachable");
		handle.state = "exited";
		assert.deepEqual(await probe(client), {
			kind: "child-exited", childPid: CHILD_PID, brokerGeneration: BROKER_GENERATION,
		});
	});

	it("can prove the writer again after a failed kernel read", async () => {
		let failed = true;
		const reader: NativeGenerationReader = async () => {
			if (failed) throw new Error("kernel read failed");
			return { kind: "found", creationTime: CHILD_CREATION };
		};
		const client = brokerClient();
		await assert.rejects(probe(client, { reader }), /kernel read failed/);
		failed = false;
		assert.equal((await probe(client, { reader })).kind, "attachable");
	});
});

/**
 * What one slot's record says about a running child, and what it refuses to say.
 *
 * The explicit release asks this about a row whose launch recorded no process id, so
 * an absent record, a record that cannot be read, a child that already exited and a
 * child whose identity cannot be reported must all stay distinguishable: only a
 * running managed child is evidence of a writer.
 */
describe("broker slot probe", () => {
	function slotProbe(client: Client, recordedPid?: number | null) {
		return reconcile.probeBrokerSlotForRunningChild({ client, slot: SLOT, recordedPid, readNativeGeneration: async () => ({ kind: "found", pid: CHILD_PID, creationTime: CHILD_CREATION }) });
	}

	it("reports a running child, and disconnects before it answers", async () => {
		let disconnected = 0;
		const live = await slotProbe(brokerClient({ onDisconnect: () => (disconnected += 1) }));
		assert.deepEqual(live, { kind: "live", pid: CHILD_PID });
		assert.equal(disconnected, 1, "a probe is an observation and closes what it opened");
	});

	it("answers only about the process the row recorded", async () => {
		const mismatch = { kind: "failed", reason: "the broker's child is not the process this session recorded" };
		assert.deepEqual(await slotProbe(brokerClient(), CHILD_PID + 1), mismatch);
		assert.deepEqual(
			await slotProbe(
				brokerClient({ handle: { ...attachedHandle({ state: "exited", nativePid: CHILD_PID + 1 }), disconnect: () => undefined } }),
				CHILD_PID,
			),
			mismatch,
		);
		assert.deepEqual(await slotProbe(brokerClient(), CHILD_PID), { kind: "live", pid: CHILD_PID });
	});

	it("reports an exited child as idle, and treats a folder shell or an absent record as uncertainty", async () => {
		const exited = await slotProbe(
			brokerClient({ handle: { ...attachedHandle({ state: "exited" }), disconnect: () => undefined } }),
		);
		assert.deepEqual(exited, { kind: "idle" });

		const shell = await slotProbe(
			brokerClient({ handle: { ...attachedHandle({ kind: "folder-shell" }), disconnect: () => undefined } }),
		);
		assert.deepEqual(shell, { kind: "failed", reason: "the record for that slot is not an OMP session host" });

		// An absent record says nothing about the child the slot may have started: it is
		// disclosed uncertainty, never `idle`.
		assert.deepEqual(await slotProbe(brokerClient({ record: { kind: "none" } })), { kind: "missing" });
	});

	it("still reports a running legacy child of the slot", async () => {
		const legacy = brokerClient({
			handle: {
				...attachedHandle({ kind: "managed-omp", record: brokerRecord({ kind: "managed-omp" }) }),
				disconnect: () => undefined,
			},
		});
		assert.deepEqual(await slotProbe(legacy), { kind: "live", pid: CHILD_PID });
	});

	it("refuses a record or attachment that names another slot, and closes the attachment", async () => {
		const foreign = await slotProbe(brokerClient({ record: { kind: "ok", record: brokerRecord({ slot: "host:other-slot" }) } }));
		assert.deepEqual(foreign, { kind: "failed", reason: "the broker record for that slot names a different slot" });

		// A record replaced between the read and the attach must not answer for this row.
		let disconnected = 0;
		const swapped = await slotProbe(
			brokerClient({ handle: { ...attachedHandle({ slot: "host:other-slot" }), disconnect: () => (disconnected += 1) } }),
		);
		assert.deepEqual(swapped, {
			kind: "failed",
			reason: "the broker proved a different slot than the one this row recorded",
		});
		assert.equal(disconnected, 1, "the refused attachment is still closed");
	});

	it("refuses to answer when the record, the broker or the child cannot be established", async () => {
		assert.deepEqual(await slotProbe(brokerClient({ record: { kind: "invalid", detail: "not json" } })), {
			kind: "failed",
			reason: "the broker record for that slot could not be read",
		});
		assert.deepEqual(await slotProbe(brokerClient({ handle: null })), {
			kind: "failed",
			reason: "the recorded broker could not be authenticated for that slot",
		});
		assert.deepEqual(
			await slotProbe(brokerClient({ handle: { ...attachedHandle({ state: null }), disconnect: () => undefined } })),
			{ kind: "failed", reason: "the broker did not report the state of its child" },
		);
		assert.deepEqual(
			await slotProbe(brokerClient({ handle: { ...attachedHandle({ nativePid: null }), disconnect: () => undefined } })),
			{ kind: "failed", reason: "the broker reported a running child without a process id" },
		);
	});
});

/** The ports one reconciler test drives, with every fact named explicitly. */
function reconcilePorts(overrides: Partial<OwnerReconcilePorts> = {}): OwnerReconcilePorts {
	return {
		// Nothing is read about a process unless a case says so: an unreadable occupant
		// must never be mistaken for a gone one.
		readProcessIdentity: async () => ({ kind: "unknown", detail: "no creation time was read in this case" }),
		isProcessAlive: () => false,
		brokerSlot: () => null,
		brokerProvenance: () => ({ kind: "none" }),
		probeRpc: async () => ({ kind: "no-record" }),
		probeBrokerSlot: async () => ({ kind: "idle" }),
		hasTerminal: async () => false,
		...overrides,
	};
}

async function verdictOf(ports: OwnerReconcilePorts, request: OwnerReconcileRequest = reconcileRequest()) {
	return await reconcile.createOwnerReconciler(ports).reconcile(request);
}

describe("reconciliation of a recorded rpc row", () => {
	it("makes a surviving broker child attachable on the transport it proved, with no terminal", async () => {
		const probes: Array<{ readonly slot: string; readonly expected: RecordedRpcIdentity }> = [];
		let terminalLookups = 0;
		const verdict = await verdictOf(
			reconcilePorts({
				probeRpc: async (slot, expected) => {
					probes.push({ slot, expected });
					return { kind: "attachable", pin: brokerPin() };
				},
				hasTerminal: async () => {
					terminalLookups += 1;
					return true;
				},
			}),
		);

		assert.equal(verdict.kind, "attachable");
		assert.deepEqual(verdict.kind === "attachable" ? verdict.pin : null, brokerPin());
		assert.equal(verdict.kind === "attachable" ? verdict.host.pid : null, CHILD_PID);
		assert.deepEqual(probes, [{ slot: SLOT, expected: RPC_IDENTITY }]);
		assert.equal(terminalLookups, 0, "an rpc child is never resolved as a terminal");
	});

	it("frees the row only on the broker's own report that the recorded child exited", async () => {
		const verdict = await verdictOf(
			reconcilePorts({
				probeRpc: async () => ({ kind: "child-exited", childPid: CHILD_PID, brokerGeneration: BROKER_GENERATION }),
			}),
		);

		assert.equal(verdict.kind, "free");
		assert.deepEqual(verdict.kind === "free" ? verdict.evidence : [], [
			{ kind: "broker-child-exited", slot: SLOT, childPid: CHILD_PID, brokerGeneration: BROKER_GENERATION },
		]);
	});


	it("frees the row when the broker cannot be asked and both recorded processes read as gone", async () => {
		const verdict = await verdictOf(
			reconcilePorts({ readProcessIdentity: async () => ({ kind: "gone" }) }),
		);
		assert.equal(verdict.kind, "free");
		assert.deepEqual(verdict.kind === "free" ? verdict.evidence : [], [
			{
				kind: "recorded-broker-and-child-gone",
				slot: SLOT,
				brokerGeneration: BROKER_GENERATION,
				childPid: CHILD_PID,
				childCreationTime: CHILD_CREATION,
			},
		]);
	});

	it("reads a pid a later process now holds as the recorded process being gone", async () => {
		const verdict = await verdictOf(
			reconcilePorts({
				readProcessIdentity: async pid =>
					pid === BROKER_PID ? { kind: "gone" } : { kind: "found", creationTime: "133799999999999999" },
			}),
		);
		assert.equal(verdict.kind, "free", "another creation time is not the recorded process");
	});



	it("answers a row that recorded no launch without inspecting anything", async () => {
		let reads = 0;
		const verdict = await verdictOf(
			reconcilePorts({
				probeRpc: async () => {
					reads += 1;
					return { kind: "no-record" };
				},
				readProcessIdentity: async () => {
					reads += 1;
					return { kind: "gone" };
				},
			}),
			reconcileRequest(null),
		);
		assert.equal(verdict.kind, "free");
		assert.deepEqual(verdict.kind === "free" ? verdict.evidence : [], [{ kind: "no-recorded-host" }]);
		assert.equal(reads, 0);
	});
});

/**
 * What the reconciler answers for a launch attempt that recorded no child identity,
 * and what an explicit release may use that answer for.
 *
 * The attempt is the one state nothing can prove absent, so the two questions are
 * deliberately separate: the release action may ask for an answer before any release
 * exists, and an automatic pass may only re-derive a row that already carries one —
 * and only while its durable intent is stopped.
 */

/**
 * A row recorded by an earlier build named a Collab room this version cannot read: it is
 * observed through its own broker slot or hidden terminal and never attached.
 */
describe("reconciliation of a legacy row", () => {
	it("reports a running legacy child under its own broker as live, never attachable", async () => {
		const probed: Array<{ readonly slot: string; readonly pid: number | null }> = [];
		const verdict = await verdictOf(
			reconcilePorts({
				brokerSlot: () => SLOT,
				probeBrokerSlot: async (slot, pid) => {
					probed.push({ slot, pid });
					return { kind: "live", pid: CHILD_PID };
				},
			}),
			reconcileRequest(LEGACY_HOST),
		);
		assert.equal(verdict.kind, "live");
		assert.deepEqual(probed, [{ slot: SLOT, pid: CHILD_PID }]);
	});

	it("frees a legacy row only when its broker reports the recorded child exited", async () => {
		const exited = await verdictOf(
			reconcilePorts({ brokerSlot: () => SLOT, probeBrokerSlot: async () => ({ kind: "idle" }) }),
			reconcileRequest(LEGACY_HOST),
		);
		assert.equal(exited.kind, "free");
		assert.deepEqual(exited.kind === "free" ? exited.evidence : [], [
			{ kind: "broker-child-exited", slot: SLOT, childPid: CHILD_PID, brokerGeneration: null },
		]);

		for (const probe of [
			{ kind: "missing" },
			{ kind: "failed", reason: "the broker record for that slot could not be read" },
		] as const) {
			const unknown = await verdictOf(
				reconcilePorts({ brokerSlot: () => SLOT, probeBrokerSlot: async () => probe }),
				reconcileRequest(LEGACY_HOST),
			);
			assert.equal(unknown.kind, "free", `a ${probe.kind} slot is unowned, without absence evidence`);
			assert.deepEqual(unknown.kind === "free" ? unknown.evidence : ["unexpected"], []);
		}

		// No recorded pid: an idle slot proves nothing about a child the row never named.
		const pidless = await verdictOf(
			reconcilePorts({ brokerSlot: () => SLOT, probeBrokerSlot: async () => ({ kind: "idle" }) }),
			reconcileRequest({ ...LEGACY_HOST, pid: null }),
		);
		assert.equal(pidless.kind, "free");
		assert.deepEqual(pidless.kind === "free" ? pidless.evidence : ["unexpected"], []);
	});


});

/**
 * Stop the exact child one recorded slot owns, from a window with no chat runtime.
 *
 * Everything that decides *whether* this may happen belongs to the session index; this
 * function owns the transport. What is defended here is that it stops exactly the child
 * the row recorded — proved by the broker's own record and the kernel creation time —
 * and that it reports what was and was not established.
 */
describe("stop of a recorded broker-owned child", () => {
	function stopResult(overrides: Partial<PtyStopResult> = {}): PtyStopResult {
		return {
			verified: true,
			mode: "graceful",
			nativePid: CHILD_PID,
			pidGone: true,
			tree: "empty",
			treeEvidence: "descendants-observed",
			remainingPids: [],
			checkedPids: [],
			exitCode: 0,
			detail: "the child exited",
			...overrides,
		};
	}

	/** A stoppable handle; `stop` counts its own calls. */
	function stoppable(input: {
		readonly overrides?: Partial<AttachedBrokerHandle>;
		readonly onStop?: () => void;
		readonly result?: () => PtyStopResult;
		readonly onDisconnect?: () => void;
		readonly onShutdown?: () => void;
	} = {}) {
		return {
			...attachedHandle(input.overrides),
			stop: async () => {
				input.onStop?.();
				return input.result?.() ?? stopResult();
			},
			shutdown: async () => input.onShutdown?.(),
			disconnect: () => input.onDisconnect?.(),
		};
	}

	function stopInput(
		client: Client,
		overrides: Partial<Parameters<typeof reconcile.stopBrokerOwnedHost>[0]> = {},
	): Parameters<typeof reconcile.stopBrokerOwnedHost>[0] {
		return {
			client,
			slot: SLOT,
			recordedPid: CHILD_PID,
			expected: RPC_IDENTITY,
			readNativeGeneration: readsRecordedChild,
			...overrides,
		};
	}

	it("stops the recorded child and confirms the writer gone with the tree proof", async () => {
		let stops = 0;
		let disconnects = 0;
		const stopped = await reconcile.stopBrokerOwnedHost(
			stopInput(brokerClient({ handle: stoppable({ onStop: () => (stops += 1), onDisconnect: () => (disconnects += 1) }) })),
		);

		assert.equal(stops, 1);
		assert.equal(disconnects, 1, "the temporary attachment is closed whatever the verdict was");
		assert.equal(stopped.ok && stopped.verdict.writerGone, true);
		assert.equal(stopped.ok && stopped.verdict.treeEmpty, true);
	});

	it("confirms the writer gone from the child's exit alone, and never claims an unproven tree", async () => {
		const stopped = await reconcile.stopBrokerOwnedHost(
			stopInput(
				brokerClient({
					handle: stoppable({ result: () => stopResult({ tree: "unknown", treeEvidence: "unavailable" }) }),
				}),
			),
		);
		assert.equal(stopped.ok && stopped.verdict.writerGone, true);
		assert.equal(stopped.ok && stopped.verdict.treeEmpty, false);

		const survivor = await reconcile.stopBrokerOwnedHost(
			stopInput(brokerClient({ handle: stoppable({ result: () => stopResult({ pidGone: false }) }) })),
		);
		assert.equal(survivor.ok && survivor.verdict.writerGone, false);
		assert.match(survivor.ok ? survivor.verdict.detail : "", /could not be confirmed stopped/);
	});

	it("shuts a legacy broker down only after its recorded writer is proven gone", async () => {
		const events: string[] = [];
		const legacy = stoppable({
			overrides: { kind: "managed-omp", record: brokerRecord({ kind: "managed-omp" }) },
			result: () => {
				events.push("writer-gone");
				return stopResult({ verified: false, tree: "unknown" });
			},
			onShutdown: () => events.push("broker-shutdown"),
			onDisconnect: () => events.push("disconnect"),
		});
		const stopped = await reconcile.stopBrokerOwnedHost(
			stopInput(brokerClient({ handle: legacy }), { expected: null }),
		);
		assert.equal(stopped.ok && stopped.verdict.writerGone, true);
		assert.equal(stopped.ok && stopped.verdict.treeEmpty, false);
		assert.deepEqual(events, ["writer-gone", "broker-shutdown", "disconnect"]);
		events.length = 0;
		const survivor = stoppable({
			overrides: { kind: "managed-omp", record: brokerRecord({ kind: "managed-omp" }) },
			result: () => stopResult({ pidGone: false }),
			onShutdown: () => events.push("broker-shutdown"),
		});
		const unconfirmed = await reconcile.stopBrokerOwnedHost(
			stopInput(brokerClient({ handle: survivor }), { expected: null }),
		);
		assert.equal(unconfirmed.ok && unconfirmed.verdict.writerGone, false);
		assert.deepEqual(events, [], "a still-running writer's broker stays reachable");
	});

	it("keeps the proven writer-gone result when broker shutdown is refused", async () => {
		const handle = stoppable({
			onShutdown: () => { throw new Error("shutdown refused"); },
		});
		const result = await reconcile.stopBrokerOwnedHost(stopInput(brokerClient({ handle })));
		assert.equal(result.ok && result.verdict.writerGone, true);
		assert.match(result.ok ? result.verdict.diagnosticDetail ?? "" : "", /broker did not acknowledge shutdown/);
	});

	it("reports a lost stop answer as unconfirmed rather than as nothing stopped", async () => {
		let disconnects = 0;
		const lost = await reconcile.stopBrokerOwnedHost(
			stopInput(
				brokerClient({
					handle: {
						...attachedHandle(),
						stop: async () => {
							throw new Error("the broker connection closed");
						},
						disconnect: () => (disconnects += 1),
					},
				}),
			),
		);

		assert.equal(lost.ok, false);
		assert.equal(lost.ok ? false : lost.dispatched, true, "the request had already been handed to the broker");
		assert.match(lost.ok ? "" : lost.reason, /stop request could not be confirmed/);
		assert.equal(disconnects, 1, "the attachment is still closed");
	});

	it("refuses a child that is not the recorded process, and stops nothing", async () => {
		let stops = 0;
		const refusals: Array<{ readonly name: string; readonly input: Parameters<typeof reconcile.stopBrokerOwnedHost>[0]; readonly expected: RegExp }> = [
			{
				name: "another pid",
				input: stopInput(brokerClient({ handle: stoppable({ overrides: { nativePid: 999_999 }, onStop: () => (stops += 1) }) })),
				expected: /is not the process this session recorded/,
			},
			{
				name: "a reused pid",
				input: stopInput(brokerClient({ handle: stoppable({ onStop: () => (stops += 1) }) }), {
					readNativeGeneration: async () => ({ kind: "found", creationTime: "999999999999999999" }),
				}),
				expected: /creation time does not match/,
			},
			{
				name: "another launch of the slot",
				input: stopInput(brokerClient({ handle: stoppable({ onStop: () => (stops += 1) }) }), {
					expected: { ...RPC_IDENTITY, brokerGeneration: "gen-other" },
				}),
				expected: /another launch/,
			},
			{
				name: "another child creation time",
				input: stopInput(brokerClient({ handle: stoppable({ onStop: () => (stops += 1) }) }), {
					expected: { ...RPC_IDENTITY, childCreationTime: "133711111111111111" },
				}),
				expected: /another launch/,
			},
		];
		for (const { name, input, expected } of refusals) {
			const refused = await reconcile.stopBrokerOwnedHost(input);
			assert.equal(refused.ok, false, name);
			assert.equal(refused.ok ? true : refused.dispatched, false, `${name}: nothing was handed to the broker`);
			assert.match(refused.ok ? "" : refused.reason, expected, name);
		}
		assert.equal(stops, 0, "a mismatched target is never asked to stop");
	});

	it("refuses an absent or unreadable record and an unauthenticated broker, and stops nothing", async () => {
		let stops = 0;
		const handle = stoppable({ onStop: () => (stops += 1) });
		const absent = await reconcile.stopBrokerOwnedHost(stopInput(brokerClient({ record: { kind: "none" }, handle })));
		assert.equal(absent.ok, false);
		assert.match(absent.ok ? "" : absent.reason, /no broker is recorded for this row's slot/);

		const invalid = await reconcile.stopBrokerOwnedHost(
			stopInput(brokerClient({ record: { kind: "invalid", detail: "malformed json at byte 3" }, handle })),
		);
		assert.equal(invalid.ok, false);
		assert.match(invalid.ok ? "" : invalid.reason, /record for that slot could not be read/);
		assert.doesNotMatch(invalid.ok ? "" : invalid.reason, /byte 3/);

		const unauthenticated = await reconcile.stopBrokerOwnedHost(stopInput(brokerClient({ handle: null })));
		assert.equal(unauthenticated.ok, false);
		assert.match(unauthenticated.ok ? "" : unauthenticated.reason, /could not be authenticated/);

		assert.equal(stops, 0);
	});
});
