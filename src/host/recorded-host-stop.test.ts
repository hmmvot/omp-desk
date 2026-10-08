/**
 * Tests for the explicit stop of a recorded broker-owned host, driven end to end
 * through the real modules: the session index's transaction, the reconciler, and the
 * authenticated broker stop.
 *
 * The state under test is what a reloaded window leaves behind: a row records a
 * launch this extension made, this window runs **no** chat runtime for it — so Close
 * Session has nothing to confirm — and the extension's own PTY broker may still own
 * the OMP child it started. The broker stub here is live in the sense that matters: it
 * answers the same protocol questions the real client does (a record, an authenticated
 * attach, a proven child, a stop result), so the whole path is exercised with only the
 * transport's socket replaced.
 *
 * Runner: `node --test src/host/recorded-host-stop.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import type {
  createOwnerReconciler as createOwnerReconcilerType,
  OwnerReconcilePorts,
  stopBrokerOwnedHost as stopBrokerOwnedHostType,
} from "./rpc-reconcile.ts";
import type { readClaim as readClaimType } from "./session-claim.ts";
import type {
  RecordedHostStopPort,
  SessionIndex as SessionIndexType,
  SessionIndexEntry,
  SessionIndexStore,
} from "./session-index.ts";

/**
 * The bundle's entry point.
 *
 * Both modules are re-exported explicitly rather than through `export *`, so a name
 * either of them adds later cannot make this test ambiguous.
 */
const ENTRY = `
export { createOwnerReconciler, stopBrokerOwnedHost } from "./rpc-reconcile.ts";
export { SessionIndex } from "./session-index.ts";
export { readClaim } from "./session-claim.ts";
`;

/** The part of the compiled bundle this test drives. */
interface DriverModules {
  readonly SessionIndex: typeof SessionIndexType;
  readonly createOwnerReconciler: typeof createOwnerReconcilerType;
  readonly stopBrokerOwnedHost: typeof stopBrokerOwnedHostType;
  readonly readClaim: typeof readClaimType;
}

let modules: DriverModules;
let temp: string;

/** The file the bundle re-exports from, written beside the modules it names. */
const ENTRY_PATH = fileURLToPath(new URL("./recorded-host-stop-entry.ts", import.meta.url));

before(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "omp-recorded-stop-"));
  await writeFile(ENTRY_PATH, ENTRY, "utf8");
  const outfile = path.join(temp, "driver.mjs");
  try {
    await build({
      entryPoints: [ENTRY_PATH],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
    });
  } finally {
    await rm(ENTRY_PATH, { force: true });
  }
  // The specifier is the bundle just written, so it cannot be a static import: the
  // module it exports is the one compiled above.
  modules = (await import(pathToFileURL(outfile).href)) as DriverModules;
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

/** The generation stamped into every claim and row this test writes. */
const GENERATION = "generation-reloaded";
/** The durable slot the broker record and the row's provenance name. */
const SLOT = "host:2b2b2b2b-0000-4000-8000-000000000002";
const BROKER_ID = "pty-11111111-1111-4111-8111-111111111111";
const BROKER_GENERATION = "gen-22222222-2222-4222-8222-222222222222";
/** The kernel creation times the broker captured, and the kernel agrees. */
const BROKER_CREATION = "133700000000000000";
const CHILD_CREATION = "133700000000000500";
/** The working directory the row and its session file publish. */
const CWD = process.platform === "win32" ? "C:\\work\\reloaded" : "/work/reloaded";
/** The process the row recorded, which the broker's child must be. */
const RECORDED_PID = 6200;
const ATTEMPT_STARTED_AT = "2026-09-28T10:00:00.000Z";

/** The pair one launch of this build records once its outcome was read. */
const RPC_IDENTITY = {
  slot: SLOT,
  brokerId: BROKER_ID,
  brokerGeneration: BROKER_GENERATION,
  brokerPid: 77,
  brokerCreationTime: BROKER_CREATION,
  childPid: RECORDED_PID,
  childCreationTime: CHILD_CREATION,
};

/** An identified launch, or one whose outcome was never read (a window died mid-launch). */
function recordedHost(identified: boolean): Record<string, unknown> {
  return {
    pid: identified ? RECORDED_PID : null,
    instanceId: null,
    generation: null,
    sessionId: "S-RELOADED",
    startedAt: ATTEMPT_STARTED_AT,
    transport: "rpc",
    rpc: identified ? RPC_IDENTITY : null,
  };
}

/** An in-memory `workspaceState` stand-in with the two keys this test uses. */
class TestStore implements SessionIndexStore {
  value: unknown;
  #catalog: Record<string, unknown> = {};

  get<T>(key: string): T | undefined {
    if (key === "omp.sessionIndex.v1") return this.value as T;
    return this.#catalog[key] as T | undefined;
  }

  update(key: string, value: unknown): void {
    if (key === "omp.sessionIndex.v1") {
      this.value = value;
      return;
    }
    this.#catalog[key] = value;
  }
}

/** One broker record for the row's slot, as the client would read it. */
function brokerRecord(generation = BROKER_GENERATION): Record<string, unknown> {
  return {
    version: 1,
    service: "omp-vscode-pty",
    protocolVersion: 2,
    runtimeVersion: 2,
    treeDigest: "a".repeat(64),
    brokerId: BROKER_ID,
    generation,
    slot: SLOT,
    kind: "managed-rpc",
    port: 41234,
    token: "t".repeat(43),
    brokerPid: 77,
    brokerCreationTime: BROKER_CREATION,
    startedAt: "2026-09-28T10:00:00.000Z",
    cols: 80,
    rows: 24,
    title: null,
  };
}

/** One stop result, as the broker reports it. */
function stopResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verified: true,
    mode: "graceful",
    nativePid: RECORDED_PID,
    pidGone: true,
    tree: "unknown",
    treeEvidence: "unavailable",
    remainingPids: [],
    checkedPids: [],
    exitCode: null,
    detail: "the child was asked to exit",
    ...overrides,
  };
}

type BrokerClient = Parameters<typeof stopBrokerOwnedHostType>[0]["client"];

/** A live broker stub: a record, an authenticated attach, a proven child, a stop. */
function brokerStub(options: {
  readonly generation?: string;
  readonly stop?: () => Record<string, unknown>;
  readonly onStop?: () => void;
  readonly onDisconnect?: () => void;
} = {}): BrokerClient {
  const record = brokerRecord(options.generation);
  const attach = async () => ({
    state: "attached",
    reason: "attached",
    handle: {
      slot: SLOT,
      kind: "managed-rpc",
      brokerPid: 77,
      record,
      nativePid: RECORDED_PID,
      nativeCreationTime: CHILD_CREATION,
      state: "running",
      stop: async () => {
        options.onStop?.();
        return options.stop?.() ?? stopResult();
      },
      shutdown: async () => ({ stopped: true }),
      disconnect: () => options.onDisconnect?.(),
    },
  });
  return { readRecord: async () => ({ kind: "ok", record }), attachRpcRecord: attach, attachRecord: attach } as unknown as BrokerClient;
}

/** The reconcile ports this test drives, with every external fact named. */
function ports(overrides: Partial<OwnerReconcilePorts> = {}): OwnerReconcilePorts {
  return {
    readProcessIdentity: async () => ({ kind: "unknown", detail: "not read in this case" }),
    isProcessAlive: () => false,
    brokerSlot: () => SLOT,
    brokerProvenance: () => ({ kind: "slot", slot: SLOT }),
    probeRpc: async () => ({ kind: "no-record" }),
    probeBrokerSlot: async () => ({ kind: "missing" }),
    hasTerminal: async () => false,
    ...overrides,
  };
}

interface ReloadedRow {
  readonly claimDir: string;
  readonly file: string;
  readonly index: InstanceType<typeof SessionIndexType>;
  readonly tabId: string;
}

/** One reloaded window's row: a recorded launch, no runtime, and a blocked reservation. */
async function reloadedRow(identified: boolean): Promise<ReloadedRow> {
  const claimDir = await mkdtemp(path.join(temp, "claims-"));
  const sessionDir = await mkdtemp(path.join(temp, "sessions-"));
  const file = path.join(sessionDir, "2026-09-28T10-00-00_S-RELOADED.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "S-RELOADED", cwd: CWD })}\n`, "utf8");
  const store = new TestStore();
  store.value = {
    version: 1,
    activeTabId: "tab:reloaded",
    nextOrdinal: 2,
    entries: [
      {
        tabId: "tab:reloaded",
        origin: "extension",
        sessionFile: file,
        sessionId: "S-RELOADED",
        cwd: CWD,
        scope: { profile: null, sessionDir },
        sessionDir,
        ownership: { ownerGeneration: GENERATION, draftIdentity: null, releasedAt: null },
        host: recordedHost(identified),
        createdAt: "2026-09-28T10:00:00.000Z",
        lastActiveAt: "2026-09-28T10:05:00.000Z",
        ordinal: 1,
        availability: "saved",
        detail: "the window that launched this host was reloaded",
        runIntent: "running",
      },
    ],
  };
  const index = new modules.SessionIndex({ store, claimStorageDir: claimDir });
  return { claimDir, file, index, tabId: "tab:reloaded" };
}

/**
 * The stop port the extension builds: it resolves the row's slot and drives the real
 * authenticated stop with the identity the row recorded.
 */
function stopPort(client: BrokerClient): RecordedHostStopPort {
  return {
    async stopRecordedHost(entry: SessionIndexEntry) {
      const stopped = await modules.stopBrokerOwnedHost({
        client,
        slot: SLOT,
        recordedPid: entry.host?.pid ?? null,
        expected: entry.host?.rpc ?? null,
        readNativeGeneration: async () => ({ kind: "found", creationTime: CHILD_CREATION }),
      });
      if (!stopped.ok) {
        return {
          kind: "unknown",
          detail: stopped.dispatched
            ? `${stopped.reason}. The recorded process may have stopped or may still be running; its claim is kept and nothing was started.`
            : `${stopped.reason}, so nothing was stopped.`,
        };
      }
      return {
        kind: "stopped",
        writerGone: stopped.verdict.writerGone,
        treeEmpty: stopped.verdict.treeEmpty,
        detail: stopped.verdict.detail,
        slot: SLOT,
      };
    },
  };
}

const EXPECT = { attemptStartedAt: ATTEMPT_STARTED_AT, pid: RECORDED_PID };

describe("explicit stop of a reloaded window's recorded host", () => {
  it("stops the broker-owned child and releases the claim once the proven child is gone", async () => {
    const row = await reloadedRow(true);
    let stops = 0;
    let disconnects = 0;
    const result = await row.index.stopRecordedHost(row.tabId, {
      expect: EXPECT,
      stop: stopPort(brokerStub({ onStop: () => (stops += 1), onDisconnect: () => (disconnects += 1) })),
    });

    assert.equal(stops, 1, "the recorded child is asked to stop exactly once");
    assert.equal(disconnects, 1, "the temporary attachment never outlives the stop");
    assert.equal(result.stopped, true, result.detail);
    assert.equal(result.slot, SLOT, "the caller is told which broker record to forget");

    const entry = row.index.get(row.tabId);
    assert.equal(entry?.host, null);
    assert.equal(entry?.availability, "saved");
    assert.equal(entry?.runIntent, "stopped");
    assert.notEqual(entry?.ownership?.releasedAt, null);
    assert.equal(await modules.readClaim(row.claimDir, row.file), null);
  });

  it("reports a lost stop answer truthfully without reserving an unowned session", async () => {
    const row = await reloadedRow(true);
    const result = await row.index.stopRecordedHost(row.tabId, {
      expect: EXPECT,
      stop: stopPort(
        brokerStub({
          stop: () => {
            throw new Error("the broker connection closed");
          },
        }),
      ),
    });

    assert.equal(result.stopped, false);
    assert.match(result.detail, /stop request could not be confirmed/);
    assert.doesNotMatch(result.detail, /nothing was stopped/);
    assert.equal(row.index.get(row.tabId)?.availability, "saved");
    assert.equal(await modules.readClaim(row.claimDir, row.file), null);
  });

  it("stops nothing when the slot now belongs to another launch, and keeps everything", async () => {
    const row = await reloadedRow(true);
    let stops = 0;
    const result = await row.index.stopRecordedHost(row.tabId, {
      expect: EXPECT,
      stop: stopPort(brokerStub({ generation: "gen-another-launch", onStop: () => (stops += 1) })),
    });

    assert.equal(stops, 0, "a slot of another launch is never asked to stop");
    assert.equal(result.stopped, false);
    assert.match(result.detail, /another launch/);
    assert.match(result.detail, /nothing was stopped/);
    const entry = row.index.get(row.tabId);
    assert.equal(entry?.host?.pid, RECORDED_PID, "the recorded writer is kept");
    assert.equal(entry?.availability, "saved");
    assert.equal(await modules.readClaim(row.claimDir, row.file), null);
  });



});
