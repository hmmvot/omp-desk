/**
 * Tests for the durable per-workspace session index and its lifecycle actions.
 *
 * These cover the boundaries that would open a second writer, lose a tab, or
 * delete something that is not provably dead: recovery by exact path after a
 * restart, one failed tab among several, live and unknown ownership, duplicate
 * tabs for one session, claim lifecycle across launch outcomes, and every
 * refusal boundary of session deletion. Claims and session files are real files
 * in temp directories; the memento is an in-memory stand-in for
 * `context.workspaceState`.
 *
 * Runner: `node:test`. Run with `bun test src/host/session-index.test.ts` or
 * `node --test --experimental-strip-types src/host/session-index.test.ts`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { claimPathFor, createOwnerGeneration, acquireClaim, createClaimHolder, readClaim } from "./session-claim.ts";
import type { ClaimHolder, ObservedClaim } from "./session-claim.ts";
import {
	SESSION_INDEX_STORAGE_KEY,
	acceptOwnerAbsenceEvidence,
	classifySessionAvailability,
	isAbsoluteWorkspaceDirectory,
	isRpcHost,
	parseSessionFileHeader,
	SessionIndex,
	SessionIndexError,
	normalizeWorkspaceDirectory,
	readSessionFileActivity,
	readSessionFileHeader,
	resolveSessionOrigin,
} from "./session-index.ts";
import {
	createNativeDeletionEvidenceStore,
	deleteManagedSession,
	inspectSessionDeletion,
	listNativeDeletionTransactions,
	recoverNativeDeletion,
} from "./session-lifecycle.ts";
import type { SessionDeletionOptions } from "./session-lifecycle.ts";
import type {
	AttachPin,
	DeferredReconciliation,
	OmpHostAttachRequest,
	OmpHostAttachResult,
	OmpHostHandle,
	OmpHostLaunchRequest,
	OmpHostLaunchResult,
	OmpHostLauncher,
	OwnerAbsenceEvidence,
	OwnerAbsenceSubject,
	OwnerReconcileRequest,
	OwnerReconciler,
	OwnerVerdict,
	RecordedHost,
	RecordedHostStopPort,
	RecordedHostStopResult,
	RunIntent,
	SessionIndexEntry,
	SessionIndexStore,
	TrackSessionInput,
} from "./session-index.ts";
import { catalogPaths, createCatalogStore } from "./profile-catalog.ts";
import { BROKER_SLOTS_KEY, createBrokerSlotStore, createHostSlotId, mergeBrokerSlotRecords } from "./broker-slots.ts";
import { mergeSessionIndexRecords } from "./session-index.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const roots: string[] = [];

after(async () => {
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

/** In-memory `workspaceState` stand-in; survives as the same object across restarts. */
class TestStore implements SessionIndexStore {
	/**
	 * Every key this store wrote, as a Memento keeps them.
	 *
	 * The index writes two records — the shared rows and this window's own
	 * observations — so a double that keeps one value for every key would lose the
	 * shared record to the local one. `value` below still means "the persisted session
	 * index", which is what these assertions are about.
	 */
	readonly values = new Map<string, unknown>();

	get value(): unknown {
		return this.values.get(SESSION_INDEX_STORAGE_KEY);
	}

	set value(next: unknown) {
		this.values.set(SESSION_INDEX_STORAGE_KEY, next);
	}

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

/** A memento whose writes never land: the paths that must not act on an unrecorded fact. */
class FailingStore extends TestStore {
	override async update(): Promise<void> {
		throw new Error("the memento is not writable");
	}
}

/**
 * A memento whose writes can be failed on demand, then allowed again, so a
 * durable barrier can be tested: what an operation publishes before its write
 * lands, and what it keeps after a write fails.
 */
class FlakyStore extends TestStore {
	failWrites = false;

	override async update(key: string, value: unknown): Promise<void> {
		if (this.failWrites) throw new Error("the memento is not writable");
		await super.update(key, value);
	}
}

interface TempWorkspace {
	readonly claimDir: string;
	readonly sessionDir: string;
	readonly cwd: string;
}

async function tempWorkspace(): Promise<TempWorkspace> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-index-"));
	roots.push(root);
	const claimDir = path.join(root, "claims");
	const sessionDir = path.join(root, "sessions");
	const cwd = path.join(root, "project");
	await mkdir(claimDir, { recursive: true });
	await mkdir(sessionDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	return { claimDir, sessionDir, cwd };
}

/** An OMP session file: a fixed-width title slot, then the session header. */
async function makeSessionFile(sessionDir: string, sessionId: string, cwd: string): Promise<string> {
	const file = path.join(sessionDir, `2026-09-24T10-00-00_${sessionId}.jsonl`);
	const slot = JSON.stringify({
		type: "session_title",
		v: 1,
		title: "",
		updatedAt: "2026-09-24T10:00:00.000Z",
	}).padEnd(255, " ");
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: "2026-09-24T10:00:00.000Z",
		cwd,
	});
	await writeFile(file, `${slot}\n${header}\n`, "utf8");
	return file;
}

/** A host the rpc broker launched: the OMP child's pid plus the broker/child identity the index records. */
function runningHandle(sessionId = "S-LIVE"): OmpHostHandle & { pid: number } {
	return {
		pid: 4242,
		sessionId,
		rpc: {
			slot: PROVEN_BROKER_SLOT,
			brokerId: "broker-id-of-record",
			brokerGeneration: "broker-generation-of-record",
			brokerPid: 4141,
			brokerCreationTime: "133700000000000000",
			childPid: 4242,
			childCreationTime: "133700000000000000",
		},
	};
}

/** One reserved draft tab plus the entry the index holds for it. */
async function draftEntry(): Promise<SessionIndexEntry> {
	const { claimDir, cwd } = await tempWorkspace();
	const index = indexFor(new TestStore(), claimDir);
	const draft = await index.createDraft({ cwd });
	const entry = index.get(draft.tabId);
	assert.ok(entry, "a draft always has an entry");
	return entry;
}

/**
 * A session file this extension manages: reserved as a draft, promoted to the
 * exact file, then confirmed stopped. That is the shape of a tab that may be
 * resumed, and the only shape ever handed to a launcher.
 */
async function managedSession(index: SessionIndex, file: string, cwd: string): Promise<SessionIndexEntry> {
	const draft = await index.createDraft({ cwd });
	assert.equal((await index.promoteDraft(draft.tabId, file)).status, "promoted");
	const stopped = await index.closeSession(draft.tabId, { confirmedStopped: true });
	assert.equal(stopped.released, true, "a managed fixture must leave no claim behind");
	// Closing only releases the claim with proof. The run intent is then restored
	// to `running`, so the fixture stands for a session the user was running when
	// its writer went away, which is what a restore pass opens. Tests about the
	// stopped presentation set the intent themselves (see "stopped intent is an
	// admission rule").
	await index.setRunIntent(draft.tabId, "running");
	const entry = index.get(draft.tabId);
	assert.ok(entry, "a promoted draft always has an entry");
	assert.equal(entry.origin, "extension");
	assert.equal(entry.availability, "saved");
	return entry;
}

/**
 * Register an OMP history file and mark the row as the user's open session.
 *
 * A History click registers the discovered file and immediately opens it, so the
 * durable intent such a row carries is the one that open leaves behind. A restore
 * pass opens only rows with that intent: a row nobody asked to run stays stopped
 * (the "stopped intent is an admission rule" tests own that behavior).
 */
async function openedImported(index: SessionIndex, input: TrackSessionInput): Promise<SessionIndexEntry> {
	const entry = await index.trackSession(input);
	await index.setRunIntent(entry.tabId, "running");
	return entry;
}

interface RecordingLauncher {
	readonly launcher: OmpHostLauncher;
	readonly requests: OmpHostLaunchRequest[];
	readonly attachRequests: OmpHostAttachRequest[];
}

/** A launcher that replays `outcomes` in order, keeps the last one, and refuses to attach. */
function recordingLauncher(...outcomes: OmpHostLaunchResult[]): RecordingLauncher {
	if (outcomes.length === 0) throw new Error("recordingLauncher needs at least one outcome");
	const requests: OmpHostLaunchRequest[] = [];
	const attachRequests: OmpHostAttachRequest[] = [];
	const launcher: OmpHostLauncher = {
		async launch(request: OmpHostLaunchRequest): Promise<OmpHostLaunchResult> {
			requests.push(request);
			const outcome = outcomes[Math.min(requests.length - 1, outcomes.length - 1)];
			return outcome ?? outcomes[outcomes.length - 1]!;
		},
		async attach(request: OmpHostAttachRequest): Promise<OmpHostAttachResult> {
			attachRequests.push(request);
			return { state: "unavailable", reason: "attach is not scripted for this test" };
		},
	};
	return { launcher, requests, attachRequests };
}

/**
 * A launcher that always answers `attach` with `result`, and whose `launch` would
 * succeed — so a test that sees a launch has caught an unwanted spawn.
 */
function attachingLauncher(result: OmpHostAttachResult): RecordingLauncher {
	const requests: OmpHostLaunchRequest[] = [];
	const attachRequests: OmpHostAttachRequest[] = [];
	const launcher: OmpHostLauncher = {
		async launch(request: OmpHostLaunchRequest): Promise<OmpHostLaunchResult> {
			requests.push(request);
			return { state: "running", host: runningHandle() };
		},
		async attach(request: OmpHostAttachRequest): Promise<OmpHostAttachResult> {
			attachRequests.push(request);
			return result;
		},
	};
	return { launcher, requests, attachRequests };
}

/**
 * A restarted index over one session whose host and claim were recorded by an
 * earlier pass: the in-memory live handle is gone, the durable claim and the
 * recorded host are not — the exact reload situation reattach exists for.
 *
 * The fixture is a session this extension created and resumed, never an adopted
 * file: an adopted session is never launched, so it has no recorded host and no
 * attach to test.
 */
async function restartedWithRecordedHost(sessionId = "S-ATTACH"): Promise<{
	readonly claimDir: string;
	readonly file: string;
	readonly tabId: string;
	readonly index: SessionIndex;
	readonly handle: OmpHostHandle;
}> {
	const { claimDir, sessionDir, cwd } = await tempWorkspace();
	const store = new TestStore();
	const file = await makeSessionFile(sessionDir, sessionId, cwd);
	const handle = runningHandle(sessionId);
	const first = indexFor(store, claimDir, DEAD_WINDOW);
	const tab = await managedSession(first, file, cwd);
	const started = recordingLauncher({ state: "running", host: handle });
	const report = await first.restoreAll({ reconciler: noRecordedHost, launcher: started.launcher });
	assert.equal(report.restored.length, 1);
	assert.ok((await readClaim(claimDir, file)) !== null);
	return { claimDir, file, tabId: tab.tabId, index: indexFor(store, claimDir), handle };
}

/** The broker transport a reconciler proves for an attachable verdict about `host`. */
function provenPin(host: OmpHostHandle): AttachPin {
	return {
		kind: "broker",
		slot: PROVEN_BROKER_SLOT,
		brokerId: "broker-id-of-record",
		brokerGeneration: "broker-generation-of-record",
		brokerPid: 4242,
		brokerCreationTime: "133700000000000000",
		nativePid: host.pid ?? 900,
		nativeCreationTime: "133700000000000000",
	};
}

/** The exact process and transport a reconciler proves for its attachable verdict. */
function attachableHost(host: OmpHostHandle, pin?: AttachPin): OwnerReconciler {
	return {
		async reconcile() {
			return {
				kind: "attachable",
				host,
				pin: pin ?? provenPin(host),
				detail: `pid ${host.pid} still hosts this session`,
			};
		},
	};
}

/** The broker slot the attachable fixtures prove; every attach must re-prove this one. */
const PROVEN_BROKER_SLOT = "host:3f0f0f0f-0000-4000-8000-000000000001";

/** Proves absence only from this index's own record: nothing was ever launched. */
const noRecordedHost: OwnerReconciler = {
	async reconcile() {
		return { kind: "free", evidence: [{ kind: "no-recorded-host" }] };
	},
};

/**
 * The absence evidence a row's own recorded launch supports once its broker and child
 * are gone, or `null` when the record identifies nothing that could be proven gone.
 *
 * An rpc row needs its full broker/child identity; a legacy broker-owned row records no
 * child creation time, so only the reporting slot and the child pid can be named.
 */
function goneEvidenceOf(host: RecordedHost | null): OwnerAbsenceEvidence | null {
	if (host === null) return null;
	if (isRpcHost(host)) {
		const rpc = host.rpc ?? null;
		if (rpc === null || rpc.childPid === null || rpc.childCreationTime === null) return null;
		return {
			kind: "recorded-broker-and-child-gone",
			slot: rpc.slot,
			brokerGeneration: rpc.brokerGeneration,
			childPid: rpc.childPid,
			childCreationTime: rpc.childCreationTime,
		};
	}
	if (host.pid === null) return null;
	return { kind: "broker-child-exited", slot: PROVEN_BROKER_SLOT, childPid: host.pid, brokerGeneration: null };
}

/**
 * Proves absence from the row's own recorded launch: the broker that hosted it and
 * the process it recorded are gone. This is the evidence a row that ran in this
 * extension and then stopped can support.
 */
const recordedHostGone: OwnerReconciler = {
	async reconcile(request) {
		const proof = goneEvidenceOf(request.host);
		return proof === null
			? { kind: "unknown", detail: "no absence this entry's own record can support was observed" }
			: { kind: "free", evidence: [proof] };
	},
};

/** Proves absence from a released claim; valid for entries with a recorded release. */
const releasedClaim: OwnerReconciler = {
	async reconcile() {
		return { kind: "free", evidence: [{ kind: "claim-released" }] };
	},
};

const freeWithoutEvidence: OwnerReconciler = {
	async reconcile() {
		return { kind: "free", evidence: [] };
	},
};

const liveHost: OwnerReconciler = {
	async reconcile(request) {
		return { kind: "live", detail: `A writer still holds ${request.sessionFile ?? request.draftIdentity}` };
	},
};

const unreconcilable: OwnerReconciler = {
	async reconcile() {
		return { kind: "unknown", detail: "the registry could not be read" };
	},
};

/**
 * One window's index over one shared memento and claim directory. `claimHolder`
 * defaults to a live lease for this process; a fixture that models a window
 * whose extension host is gone passes `DEAD_WINDOW`.
 */
function indexFor(store: SessionIndexStore, claimDir: string, claimHolder?: ClaimHolder): SessionIndex {
	return new SessionIndex({ store, claimStorageDir: claimDir, claimHolder });
}

/**
 * A memento whose write can be held open.
 *
 * A lifecycle operation's memento write is the last step of its mutation region,
 * so holding it parks the operation *inside* its own claim work while the tests
 * queue what has to be ordered behind it — without a sleep and without reaching
 * into the index.
 */
class HeldStore implements SessionIndexStore {
	/** Every key this store wrote; see {@link TestStore.values}. */
	readonly values = new Map<string, unknown>();
	#holding = false;
	readonly #waiting: (() => void)[] = [];
	readonly #arrived: (() => void)[] = [];

	get value(): unknown {
		return this.values.get(SESSION_INDEX_STORAGE_KEY);
	}

	set value(next: unknown) {
		this.values.set(SESSION_INDEX_STORAGE_KEY, next);
	}

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	/** Hold this write and every later one until {@link HeldStore.release}. */
	hold(): void {
		this.#holding = true;
	}

	/** Resolves when a write arrives while held; arm it before starting the operation. */
	nextWrite(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#arrived.push(resolve);
		return promise;
	}

	release(): void {
		this.#holding = false;
		for (const resolve of this.#waiting.splice(0)) resolve();
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
		for (const resolve of this.#arrived.splice(0)) resolve();
		if (!this.#holding) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiting.push(resolve);
		await promise;
	}
}

/**
 * Hold one tab's lifecycle open until the test releases it, so the operations a
 * test starts afterwards are queued behind it in a known order.
 */
function holdGate(index: SessionIndex, tabId: string): { readonly release: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	void index.lifecycle.run(tabId, async () => {
		await promise;
	});
	return { release: resolve };
}

/**
 * The lease of a window whose extension host no longer runs — what a reload
 * leaves behind on disk.
 */
const DEAD_WINDOW: ClaimHolder = createClaimHolder(4194303);

// ── Indexing and restart recovery ───────────────────────────────────────────

describe("session index", () => {
	it("recovers a promoted draft by exact path after a window restart", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);

		const draft = await index.createDraft({ cwd, scope: { profile: "work", sessionDir } });
		assert.equal(draft.kind, "draft");
		assert.equal(draft.sessionFile, null);
		assert.equal(draft.availability, "draft");

		const file = await makeSessionFile(sessionDir, "S-ONE", cwd);
		const unmaterialized = await index.promoteDraft(draft.tabId, path.join(sessionDir, "missing.jsonl"));
		assert.equal(unmaterialized.status, "not-materialized");
		assert.equal(index.get(draft.tabId)?.kind, "draft");

		const promotion = await index.promoteDraft(draft.tabId, file);
		assert.equal(promotion.status, "promoted");
		await index.setActiveTab(draft.tabId);

		// The persisted snapshot is the only thing a restart sees.
		const restarted = indexFor(store, claimDir);
		const entry = restarted.list()[0];
		assert.ok(entry);
		assert.equal(entry.tabId, draft.tabId, "the tab identity survives promotion and restart");
		assert.equal(entry.kind, "session");
		assert.equal(entry.sessionFile, file);
		assert.equal(entry.sessionId, "S-ONE");
		assert.equal(entry.sessionDir, sessionDir);
		assert.equal(entry.cwd, normalizeWorkspaceDirectory(cwd));
		assert.equal(entry.scope.profile, "work");
		assert.equal(entry.scope.sessionDir, sessionDir);
		assert.equal(restarted.activeTabId, draft.tabId);
	});

	it("keeps one tab per session file", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-DUP", cwd);

		const first = await index.trackSession({ sessionFile: file, cwd });
		const second = await index.trackSession({ sessionFile: file, cwd });

		assert.equal(second.tabId, first.tabId);
		assert.equal(index.list().length, 1);
		// Registering the file again returns the tab that is already there — the
		// repeated click — and changes nothing about what the row is.
		assert.equal(first.origin, "imported");
		assert.equal(second.origin, "imported");
		assert.equal(second.availability, first.availability);
		assert.equal(second.ownership?.ownerGeneration, first.ownership?.ownerGeneration);
	});

	it("refuses to promote a draft onto a file another owner has claimed", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-TAKEN", cwd);
		const foreign = await acquireClaim(claimDir, file, createOwnerGeneration(), createClaimHolder());

		try {
			const draft = await index.createDraft({ cwd });
			const draftIdentity = draft.ownership?.draftIdentity;
			assert.ok(draftIdentity);

			const promotion = await index.promoteDraft(draft.tabId, file);
			assert.equal(promotion.status, "claim-conflict");
			assert.equal(index.get(draft.tabId)?.kind, "draft");
			// The reserved draft claim and the foreign claim are both untouched.
			assert.equal((await readClaim(claimDir, draftIdentity))?.ownerGeneration, draft.ownership?.ownerGeneration);
			assert.equal((await readClaim(claimDir, file))?.ownerGeneration, foreign.ownerGeneration);
		} finally {
			await foreign.release();
		}
	});
});

// ── Partial restore ─────────────────────────────────────────────────────────

describe("restoreAll", () => {
	it("restores the other tabs when one session file is missing", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const good = await makeSessionFile(sessionDir, "S-GOOD", cwd);
		const gone = await makeSessionFile(sessionDir, "S-GONE", cwd);
		const goodTab = await managedSession(index, good, cwd);
		const goneTab = await managedSession(index, gone, cwd);
		await rm(gone, { force: true });

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle() });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(report.restored.length, 1);
		assert.equal(report.restored[0]?.tabId, goodTab.tabId);
		assert.equal(requests.length, 1, "a missing file must not stop the other tab from starting");
		assert.equal(requests[0]?.sessionFile, good);
		assert.equal(requests[0]?.cwd, normalizeWorkspaceDirectory(cwd));

		assert.equal(report.failures.length, 1);
		assert.equal(report.failures[0]?.tabId, goneTab.tabId);
		assert.equal(report.failures[0]?.kind, "missing-file");

		// Both tabs survive, and only the restored one holds a claim.
		assert.equal(index.list().length, 2);
		assert.equal(index.get(goneTab.tabId)?.availability, "failed");
		assert.equal(index.get(goodTab.tabId)?.availability, "live");
		assert.ok((await readClaim(claimDir, good)) !== null);
		assert.equal(await readClaim(claimDir, gone), null);
		assert.equal(await readClaim(claimDir, goneTab.tabId), null);
	});

	it("reports drafts without starting a host unless asked", async () => {
		const { claimDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const draft = await index.createDraft({ cwd });

		const idle = recordingLauncher({ state: "running", host: runningHandle() });
		const first = await index.restoreAll({ reconciler: noRecordedHost, launcher: idle.launcher });
		assert.equal(first.drafts.length, 1);
		assert.equal(first.drafts[0]?.tabId, draft.tabId);
		assert.equal(idle.requests.length, 0);

		const started = recordingLauncher({ state: "running", host: runningHandle() });
		const second = await index.restoreAll({
			reconciler: noRecordedHost,
			launcher: started.launcher,
			restoreDrafts: true,
		});
		assert.equal(second.restored.length, 1);
		assert.equal(started.requests.length, 1);
		assert.equal(started.requests[0]?.sessionFile, null, "a draft starts a fresh session, not a resume");
		assert.equal(index.get(draft.tabId)?.availability, "live");
	});

	it("starts exactly one host when two tabs point at one session", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-SHARED", cwd);

		const first = await managedSession(index, file, cwd);
		// A second tab this extension created for the same file, released on a
		// confirmed stop: both tabs now look resumable, and only the batch rule
		// can keep them apart.
		const second = await managedSession(index, file, cwd);

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle() });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(requests.length, 1);
		assert.equal(report.restored.length, 1);
		assert.equal(report.restored[0]?.tabId, first.tabId);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]?.tabId, second.tabId);
		assert.equal(report.conflicts[0]?.kind, "duplicate");
	});

	it("restores only the rows its caller pinned, leaving later rows to their own opener", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const firstFile = await makeSessionFile(sessionDir, "S-PIN-A", cwd);
		const secondFile = await makeSessionFile(sessionDir, "S-PIN-B", cwd);
		const first = await openedImported(index, { sessionFile: firstFile, cwd });
		const second = await openedImported(index, { sessionFile: secondFile, cwd });

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-PIN-A") });
		const pinned = await index.restoreAll({ reconciler: noRecordedHost, launcher, only: new Set([first.tabId]) });

		assert.deepEqual(pinned.order, [first.tabId], "a pinned pass covers exactly the rows it was given");
		assert.equal(requests.length, 1, "and starts nothing for a row outside them");
		assert.equal(requests[0]?.tabId, first.tabId);
		assert.equal(await readClaim(claimDir, secondFile), null, "nor takes a claim for one");
		assert.equal(index.get(second.tabId)?.availability, "saved", "an unpinned row keeps the state it had");

		// A row outside a pinned pass is restored by the pass that does cover it —
		// the click that created it, or a later batch.
		const later = recordingLauncher({ state: "running", host: runningHandle("S-PIN-B") });
		const all = await index.restoreAll({ reconciler: noRecordedHost, launcher: later.launcher });

		assert.deepEqual(all.order, [first.tabId, second.tabId]);
		assert.equal(later.requests.length, 1);
		assert.equal(later.requests[0]?.tabId, second.tabId);
		assert.deepEqual(all.attached.map(tab => tab.tabId), [first.tabId], "the already-running row is attached, not relaunched");
	});

	it("refuses a second restore of one tab while the first is still in flight", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-IN-FLIGHT", cwd);
		const imported = await index.trackSession({ sessionFile: file, cwd });
		// The first restore is parked inside its own lifecycle queue, so it is still
		// the tab's restore when the second one arrives: the state a click and an
		// activation pass would be in if they ran together.
		const gate = holdGate(index, imported.tabId);
		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-IN-FLIGHT") });

		const first = index.restore(imported.tabId, { reconciler: noRecordedHost, launcher });
		const second = await index.restore(imported.tabId, { reconciler: noRecordedHost, launcher });

		assert.ok(second.status === "conflict");
		assert.equal(second.kind, "duplicate", "one tab is restored once, whatever asks for it");
		gate.release();
		const settled = await first;
		assert.ok(settled.status === "restored");
		assert.equal(requests.length, 1, "two concurrent restores of one tab start exactly one host");
		assert.equal((await readClaim(claimDir, file))?.ownerGeneration, imported.ownership?.ownerGeneration);
	});
});

// ── Deferred draft reconciliation ───────────────────────────────────────────

describe("reconcileDeferred", () => {
	/**
	 * A draft this window launched once, whose terminal then died with a reload:
	 * the durable row and claim are exactly what the dead window left behind.
	 */
	async function draftLeftLiveByAReload(): Promise<{
		readonly claimDir: string;
		readonly store: TestStore;
		readonly index: SessionIndex;
		readonly tabId: string;
		readonly identity: string;
	}> {
		const { claimDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir, DEAD_WINDOW);
		const draft = await index.createDraft({ cwd });
		const identity = draft.ownership?.draftIdentity;
		assert.ok(identity, "a draft always reserves a claim identity");
		const handle = runningHandle("S-DRAFT");
		const started = recordingLauncher({ state: "running", host: handle });
		const outcome = await index.restore(draft.tabId, { reconciler: noRecordedHost, launcher: started.launcher });
		assert.equal(outcome.status, "restored");
		assert.equal(index.get(draft.tabId)?.availability, "live");
		return { claimDir, store, index, tabId: draft.tabId, identity };
	}

	it("re-derives a draft row a reload left reading live", async () => {
		const { claimDir, store, tabId, identity } = await draftLeftLiveByAReload();
		// The reload: the same durable state, a fresh index, no live handle.
		const restarted = indexFor(store, claimDir);
		const claimBefore = await readClaim(claimDir, identity);
		assert.ok(claimBefore !== null);

		const report = await restarted.reconcileDeferred({ reconciler: recordedHostGone });

		assert.deepEqual(report.order, [tabId]);
		assert.deepEqual(report.running, []);
		assert.equal(report.reconciled.length, 1);
		assert.equal(report.reconciled[0]?.availability, "draft");
		assert.equal(report.reconciled[0]?.startable, true, "a provably dead writer must not block the tab forever");
		assert.equal(report.reconciled[0]?.attachableHost, null);
		assert.equal(restarted.get(tabId)?.availability, "draft");
		// The pass starts nothing and holds nothing: the claim the dead window
		// left behind is exactly the record it was.
		assert.deepEqual(await readClaim(claimDir, identity), claimBefore);
		// A restarted index sees the re-derived row, not the stale one.
		assert.equal(indexFor(store, claimDir).get(tabId)?.availability, "draft");
	});


	it("leaves a draft this window is running exactly as it is", async () => {
		const { claimDir, store, index, tabId, identity } = await draftLeftLiveByAReload();
		const claimBefore = await readClaim(claimDir, identity);

		const report = await index.reconcileDeferred({ reconciler: recordedHostGone });

		assert.deepEqual(report.running, [tabId]);
		assert.deepEqual(report.reconciled, []);
		assert.equal(index.get(tabId)?.availability, "live");
		assert.deepEqual(await readClaim(claimDir, identity), claimBefore);
	});

	it("re-derives the one tab it was asked about", async () => {
		const { claimDir, store, tabId } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);

		const other = await restarted.reconcileDeferred({ reconciler: recordedHostGone, tabId: "tab:other" });

		assert.deepEqual(other.order, []);
		assert.deepEqual(other.reconciled, []);
		assert.equal(restarted.get(tabId)?.availability, "live", "an unrelated tab is not reconciled by a single-row open");
	});
});

// ── Ownership conflicts ─────────────────────────────────────────────────────

describe("ownership conflicts", () => {
	it("never starts a writer when a live owner is reported", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-LIVE", cwd);
		await managedSession(index, file, cwd);

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle() });
		const report = await index.restoreAll({ reconciler: liveHost, launcher });

		assert.equal(requests.length, 0);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]?.kind, "live");
		assert.equal(index.get(index.list()[0]?.tabId ?? "")?.availability, "live");
		// The claim taken for the check was returned, so the real owner keeps it.
		assert.equal(await readClaim(claimDir, file), null);
	});



	it("leaves another window's claim and file untouched", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-FOREIGN", cwd);
		await managedSession(index, file, cwd);
		const foreign = await acquireClaim(claimDir, file, createOwnerGeneration(), createClaimHolder());

		try {
			const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle() });
			const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

			assert.equal(requests.length, 0);
			assert.equal(report.conflicts[0]?.kind, "claim-conflict");
			assert.equal((await readClaim(claimDir, file))?.ownerGeneration, foreign.ownerGeneration);
		} finally {
			await foreign.release();
		}
	});


});

// ── Claim lifecycle across launch outcomes ──────────────────────────────────

describe("claim lifecycle", () => {
	it("releases the claim when nothing was started, so the tab stays retryable", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-RETRY", cwd);
		const tab = await managedSession(index, file, cwd);

		const refused = recordingLauncher({ state: "not-started", reason: "the terminal could not be opened" });
		const first = await index.restoreAll({ reconciler: noRecordedHost, launcher: refused.launcher });
		assert.equal(first.failures[0]?.kind, "launch-failed");
		assert.equal(await readClaim(claimDir, file), null, "a launch that never started must free its claim");

		const retried = recordingLauncher({ state: "running", host: runningHandle() });
		const second = await index.restoreAll({ reconciler: noRecordedHost, launcher: retried.launcher });
		assert.equal(second.restored.length, 1);
		assert.equal(second.restored[0]?.tabId, tab.tabId);
	});



	it("refuses to drop a tab whose session is still claimed", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-KEEP", cwd);
		const tab = await managedSession(index, file, cwd);
		const foreign = await acquireClaim(claimDir, file, createOwnerGeneration(), createClaimHolder());

		try {
			const refused = await index.remove(tab.tabId);
			assert.equal(refused.removed, false);
			assert.equal(index.list().length, 1);
		} finally {
			await foreign.release();
		}

		const removed = await index.remove(tab.tabId);
		assert.equal(removed.removed, true);
		assert.equal(index.list().length, 0);
		assert.equal(await readClaim(claimDir, file), null);
	});
});

// ── Reattach after a reload ─────────────────────────────────────────────────

describe("reattach", () => {
	it("reattaches to the exact host it recorded instead of starting a second one", async () => {
		const { claimDir, file, tabId, index, handle } = await restartedWithRecordedHost();
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });

		const report = await index.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(report.restored.length, 0);
		assert.equal(report.conflicts.length, 0);
		assert.equal(report.attached.length, 1);
		assert.equal(report.attached[0]?.tabId, tabId);
		assert.equal(report.attached[0]?.sessionFile, file);
		assert.equal(requests.length, 0, "reattaching must never spawn a process");
		assert.equal(attachRequests.length, 1);
		assert.equal(attachRequests[0]?.sessionFile, file);
		assert.equal(attachRequests[0]?.recordedHost.pid, handle.pid);
		assert.deepEqual(attachRequests[0]?.recordedHost.rpc, handle.rpc);
		assert.equal(attachRequests[0]?.ownerGeneration, index.get(tabId)?.ownership?.ownerGeneration);
		assert.deepEqual(
			attachRequests[0]?.pin,
			{
				kind: "broker",
				slot: PROVEN_BROKER_SLOT,
				brokerId: "broker-id-of-record",
				brokerGeneration: "broker-generation-of-record",
				brokerPid: 4242,
				brokerCreationTime: "133700000000000000",
				nativePid: handle.pid,
				nativeCreationTime: "133700000000000000",
			},
			"the attach drives exactly the transport the verdict proved",
		);
		assert.ok((await readClaim(claimDir, file)) !== null, "the attached host keeps its claim");
		assert.equal(index.get(tabId)?.availability, "live");

		// The attached host is now held in memory, so a later pass reuses it as-is.
		const again = await index.restoreAll({ reconciler: attachableHost(handle), launcher });
		assert.equal(again.attached.length, 1);
		assert.equal(attachRequests.length, 1);
	});

	it("never attaches when the live host does not match its own record", async () => {
		const { tabId, index, handle } = await restartedWithRecordedHost();
		const impostors: OmpHostHandle[] = [
			{ ...handle, pid: 999 },
			{ ...handle, rpc: handle.rpc === null ? null : { ...handle.rpc, brokerGeneration: "broker-generation-other" } },
			{ ...handle, sessionId: "S-OTHER" },
		];

		for (const impostor of impostors) {
			const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: impostor });
			const report = await index.restoreAll({ reconciler: attachableHost(impostor), launcher });

			assert.equal(report.attached.length, 0);
			assert.equal(report.conflicts[0]?.kind, "live");
			assert.equal(attachRequests.length, 0, "a host that does not match the record is never attached");
			assert.equal(requests.length, 0, "and it never becomes a second process either");
		}
		assert.equal(index.get(tabId)?.availability, "live");
	});

	it("does not spawn after a failed attach while fresh ownership still verifies the live writer", async () => {
		const { claimDir, file, tabId, index, handle } = await restartedWithRecordedHost();
		const { launcher, requests, attachRequests } = attachingLauncher({
			state: "unavailable",
			reason: "the native terminal could not be confirmed",
		});

		const report = await index.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(report.restored.length, 0);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]?.kind, "live");
		assert.match(report.conflicts[0]?.detail ?? "", /Reattaching failed/);
		assert.equal(attachRequests.length, 1);
		assert.equal(requests.length, 0);
		assert.equal(await readClaim(claimDir, file), null, "failed attach ends its operation lease");
		assert.equal(index.get(tabId)?.availability, "live");
	});
});

/**
 * The durable run intent is an admission rule, not a presentation hint.
 *
 * A restart pass visits every indexed row, so without this rule a full VS Code
 * restart would start a process for a session the user stopped — undoing the user's
 * own decision and reporting it as a recovery. Nothing is started or adopted for such
 * a row, no claim is taken while deciding, and the row's availability is still
 * re-derived so a writer that is genuinely alive stays visible.
 */
describe("stopped intent is an admission rule", () => {
	/** A managed materialized row the user stopped, with no claim left behind. */
	async function stoppedRow(sessionId: string): Promise<{ readonly claimDir: string; readonly file: string; readonly tabId: string; readonly index: SessionIndex }> {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, sessionId, cwd);
		const entry = await managedSession(index, file, cwd);
		const stopped = await index.closeSession(entry.tabId, { confirmedStopped: true });
		assert.equal(stopped.released, true);
		assert.equal(index.get(entry.tabId)?.runIntent, "stopped");
		return { claimDir, file, tabId: entry.tabId, index };
	}

	it("starts nothing for a stopped row and keeps it stopped until an explicit resume", async () => {
		const { claimDir, file, tabId, index } = await stoppedRow("S-STOPPED");
		const { launcher, requests, attachRequests } = recordingLauncher({ state: "running", host: runningHandle("S-STOPPED") });

		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(requests.length, 0, "a restart never starts a process for a stopped row");
		assert.equal(attachRequests.length, 0, "and it never adopts one either");
		assert.deepEqual(
			report.stopped.map(session => session.tabId),
			[tabId],
		);
		assert.equal(report.restored.length, 0);
		assert.equal(index.get(tabId)?.runIntent, "stopped");
		assert.equal(index.get(tabId)?.availability, "saved");
		assert.equal(await readClaim(claimDir, file), null, "and it takes no claim while deciding");

		// The explicit Resume is the one caller that may, and it starts exactly once.
		const resumed = recordingLauncher({ state: "running", host: runningHandle("S-STOPPED") });
		const outcome = await index.restore(tabId, { reconciler: noRecordedHost, launcher: resumed.launcher });

		assert.equal(outcome.status, "restored");
		assert.equal(resumed.requests.length, 1);
		assert.equal(index.get(tabId)?.runIntent, "running");
	});

	it("reports a live writer of a stopped row instead of adopting it", async () => {
		const { tabId, index, handle } = await restartedWithRecordedHost();
		await index.setRunIntent(tabId, "stopped", "the user stopped this session");
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });

		const report = await index.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(attachRequests.length, 0, "a writer of a stopped session is reported, never adopted");
		assert.equal(requests.length, 0);
		assert.equal(report.attached.length, 0);
		assert.equal(report.conflicts[0]?.kind, "live");
		assert.equal(index.get(tabId)?.runIntent, "stopped");
		assert.equal(index.get(tabId)?.availability, "live", "the live writer stays visible");
	});


	it("reports a stopped row whose session file disappeared as failed", async () => {
		const { file, tabId, index } = await stoppedRow("S-GONE");
		await rm(file);
		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle() });

		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(requests.length, 0);
		assert.equal(report.failures[0]?.kind, "missing-file");
		assert.equal(index.get(tabId)?.availability, "failed");
	});
});

/**
 * Activation's attach-only draft restore.
 *
 * A reload leaves a draft's durable row, its reserved claim and its recorded
 * process identity behind while the native process keeps running. The pass must
 * adopt that exact process (one attach, zero launches) and must never start,
 * claim or rewrite anything for a draft it cannot verify.
 */
describe("live draft reattach", () => {
	/**
	 * A fileless draft a dead window launched and left behind: the durable row, the
	 * reserved claim and the recorded host are exactly what the reload kept, while
	 * the in-memory live record is gone.
	 */
	async function draftLeftLiveByAReload(sessionId = "S-DRAFT"): Promise<{
		readonly claimDir: string;
		readonly sessionDir: string;
		readonly cwd: string;
		readonly store: TestStore;
		readonly tabId: string;
		readonly identity: string;
		readonly handle: OmpHostHandle;
	}> {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const launching = indexFor(store, claimDir, DEAD_WINDOW);
		const draft = await launching.createDraft({ cwd });
		const identity = draft.ownership?.draftIdentity;
		assert.ok(identity, "a draft always reserves a claim identity");
		const handle = runningHandle(sessionId);
		const started = recordingLauncher({ state: "running", host: handle });
		const outcome = await launching.restore(draft.tabId, { reconciler: noRecordedHost, launcher: started.launcher });
		assert.equal(outcome.status, "restored");
		assert.equal(launching.get(draft.tabId)?.availability, "live");
		return { claimDir, sessionDir, cwd, store, tabId: draft.tabId, identity, handle };
	}

	it("adopts the exact process of an owned live draft instead of starting one", async () => {
		const { claimDir, store, tabId, identity, handle } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });

		const report = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(report.restored.length, 0, "activation never starts a host for a fileless row");
		assert.equal(report.conflicts.length, 0);
		assert.equal(report.drafts.length, 0, "the row is not reported as a hostless draft");
		assert.equal(report.attached.length, 1);
		assert.equal(report.attached[0]?.tabId, tabId);
		assert.equal(report.attached[0]?.sessionFile, null, "a reattached draft is still fileless");
		assert.equal(requests.length, 0, "reattaching must never spawn a process");
		assert.equal(attachRequests.length, 1, "the recorded process is adopted exactly once");
		assert.equal(attachRequests[0]?.sessionFile, null);
		assert.equal(attachRequests[0]?.recordedHost.pid, handle.pid);
		assert.deepEqual(attachRequests[0]?.recordedHost.rpc, handle.rpc);
		assert.equal(attachRequests[0]?.ownerGeneration, restarted.get(tabId)?.ownership?.ownerGeneration);
		assert.ok((await readClaim(claimDir, identity)) !== null, "the draft keeps its reserved claim");
		assert.equal(restarted.get(tabId)?.availability, "live");
		assert.equal(restarted.get(tabId)?.sessionFile, null, "nothing is bound to a file by adopting the host");

		// The adopted host is now held in this window, so a later pass reuses it as-is.
		const again = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });
		assert.equal(again.attached.length, 1);
		assert.equal(attachRequests.length, 1, "one attach, however many passes run");
		assert.equal(requests.length, 0);
	});

	it("leaves a fileless draft a provably dead writer owned to an explicit open", async () => {
		const { claimDir, store, tabId, handle } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);
		const gone = recordedHostGone;
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });

		// Activation order: the deferred pass re-derives the row, then the batch pass
		// gets it.
		await restarted.reconcileDeferred({ reconciler: gone });
		const report = await restarted.restoreAll({ reconciler: gone, launcher });

		assert.deepEqual(report.drafts.map(draft => draft.tabId), [tabId], "with no file it stays a draft");
		assert.equal(requests.length, 0, "a dead writer is not replaced by activation");
		assert.equal(attachRequests.length, 0, "and nothing is attached on its behalf");
		assert.equal(restarted.get(tabId)?.availability, "draft");
	});

	it("never attaches a draft whose live host is not the one it recorded", async () => {
		const { claimDir, store, tabId, identity, handle } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);
		const claimBefore = await readClaim(claimDir, identity);
		const impostors: OmpHostHandle[] = [
			{ ...handle, pid: 999 },
			{ ...handle, rpc: handle.rpc === null ? null : { ...handle.rpc, brokerGeneration: "broker-generation-other" } },
			{ ...handle, sessionId: "S-OTHER" },
		];

		for (const impostor of impostors) {
			const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: impostor });
			const report = await restarted.restoreAll({ reconciler: attachableHost(impostor), launcher });

			assert.equal(report.attached.length, 0);
			assert.equal(report.conflicts[0]?.kind, "live");
			assert.equal(attachRequests.length, 0, "a host that does not match the record is never attached");
			assert.equal(requests.length, 0, "and it never becomes a second process either");
		}
		assert.deepEqual(await readClaim(claimDir, identity), claimBefore, "a refusal touches no claim");
	});



	it("never attaches over another live holder of its own generation", async () => {
		const { claimDir, store, tabId, identity, handle } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);
		const generation = restarted.get(tabId)?.ownership?.ownerGeneration ?? "";
		// Another window of this workspace read the same row and re-leased the same
		// generation's claim, and it is alive. Nothing here may attach over it even
		// though every recorded fact about the process still matches.
		await acquireClaim(claimDir, identity, generation, createClaimHolder());
		const claimBefore = await readClaim(claimDir, identity);
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });

		const report = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(report.conflicts[0]?.kind, "live");
		assert.equal(attachRequests.length, 0, "a live holder is never attached over");
		assert.equal(requests.length, 0, "and never replaced by a second process");
		assert.deepEqual(await readClaim(claimDir, identity), claimBefore, "the rival's claim is untouched");
		assert.equal(restarted.get(tabId)?.sessionFile, null);
	});

	it("ends the reserved operation lease after failed adoption without spawning over a freshly verified writer", async () => {
		const { claimDir, store, tabId, identity, handle } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);
		const { launcher, requests, attachRequests } = attachingLauncher({
			state: "unavailable",
			reason: "the native terminal could not be confirmed",
		});

		const report = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(report.restored.length, 0);
		assert.equal(report.conflicts.length, 1);
		assert.equal(report.conflicts[0]?.kind, "live");
		assert.match(report.conflicts[0]?.detail ?? "", /Reattaching failed/);
		assert.equal(attachRequests.length, 1, "exactly one attach is attempted for the recorded process");
		assert.equal(requests.length, 0, "a failed adoption never becomes a new process");

		assert.equal(await readClaim(claimDir, identity), null);
		assert.equal(restarted.get(tabId)?.availability, "live");
	});

	it("binds the exact file for a promotion of the draft it reattached", async () => {
		const { claimDir, sessionDir, cwd, store, tabId, identity, handle } = await draftLeftLiveByAReload();
		const restarted = indexFor(store, claimDir);
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });
		const file = await makeSessionFile(sessionDir, "S-DRAFT", cwd);
		const started = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });
		assert.equal(started.attached.length, 1);

		// The host writes its file after the attachment; the ordinary promotion binds
		// it while the claim the attach took is still the one this window holds.
		const promotion = await restarted.promoteDraft(tabId, file);

		assert.equal(promotion.status, "promoted");
		assert.equal(restarted.get(tabId)?.sessionFile, file);
		assert.equal(restarted.get(tabId)?.availability, "live");
		assert.equal(await readClaim(claimDir, identity), null, "the reserved draft identity is retired");
		assert.ok((await readClaim(claimDir, file)) !== null, "and replaced by the canonical claim");

		// A pass after the promotion finds this window running the tab: nothing is
		// attached or started again, and the file stays bound.
		const after = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });
		assert.equal(after.attached.length, 1);
		assert.equal(after.attached[0]?.sessionFile, file);
		assert.equal(attachRequests.length, 1);
		assert.equal(requests.length, 0);
	});
});

// ── Classification policy ───────────────────────────────────────────────────

describe("availability policy", () => {
	it("never accepts absence evidence about a host this index never launched", async () => {
		const entry = await draftEntry();
		const rpc = {
			slot: PROVEN_BROKER_SLOT,
			brokerId: "broker-id",
			brokerGeneration: "broker-gen-9",
			brokerPid: 800,
			brokerCreationTime: "133700000000000001",
			childPid: 900,
			childCreationTime: "133700000000000002",
		};
		const gone = {
			kind: "recorded-broker-and-child-gone",
			slot: rpc.slot,
			brokerGeneration: rpc.brokerGeneration,
			childPid: 900,
			childCreationTime: rpc.childCreationTime,
		} as const;
		const exited = {
			kind: "broker-child-exited",
			slot: rpc.slot,
			childPid: 900,
			brokerGeneration: rpc.brokerGeneration,
		} as const;
		assert.equal(acceptOwnerAbsenceEvidence(entry, { kind: "no-recorded-host" }), true);
		assert.equal(acceptOwnerAbsenceEvidence(entry, { kind: "claim-released" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(entry, gone), false);
		assert.equal(acceptOwnerAbsenceEvidence(entry, exited), false);

		const recordedHost: RecordedHost = {
			pid: 900,
			instanceId: null,
			generation: null,
			sessionId: "S",
			startedAt: "2026-09-24T11:00:00.000Z",
			transport: "rpc",
			rpc,
		};
		const withHost: SessionIndexEntry = { ...entry, host: recordedHost };
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { kind: "no-recorded-host" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, gone), true);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, exited), true);
		// Every fact of the recorded identity must match: another slot, broker
		// generation, child pid or child creation time is a different process.
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, slot: "host:other" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, brokerGeneration: "broker-gen-other" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, childPid: 901 }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...gone, childCreationTime: "133700000000000003" }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...exited, childPid: 901 }), false);
		assert.equal(acceptOwnerAbsenceEvidence(withHost, { ...exited, brokerGeneration: "broker-gen-other" }), false);

		// A launch attempt whose outcome was never read names no child at all, so
		// nothing that is later observed gone can prove anything about it.
		const unread: SessionIndexEntry = {
			...withHost,
			host: { ...recordedHost, pid: null, rpc: { ...rpc, childPid: null, childCreationTime: null } },
		};
		assert.equal(acceptOwnerAbsenceEvidence(unread, gone), false);
		assert.equal(acceptOwnerAbsenceEvidence(unread, exited), false);
		assert.equal(acceptOwnerAbsenceEvidence(unread, { kind: "no-recorded-host" }), false);

		// A legacy record has no creation time to compare: only the reporting child's
		// pid can be matched, and the combined item is never accepted for it.
		const legacy: SessionIndexEntry = { ...withHost, host: { ...recordedHost, transport: undefined, rpc: undefined } };
		assert.equal(acceptOwnerAbsenceEvidence(legacy, gone), false);
		assert.equal(acceptOwnerAbsenceEvidence(legacy, { ...exited, brokerGeneration: null }), true);
		assert.equal(acceptOwnerAbsenceEvidence(legacy, { ...exited, childPid: 901, brokerGeneration: null }), false);

		// A release that predates the recorded host does not clear it.
		const staleRelease: SessionIndexEntry = {
			...withHost,
			ownership: {
				ownerGeneration: entry.ownership?.ownerGeneration ?? "g",
				draftIdentity: null,
				releasedAt: "2026-09-24T09:00:00.000Z",
			},
		};
		assert.equal(acceptOwnerAbsenceEvidence(staleRelease, { kind: "claim-released" }), false);
	});


	it("binds attach to the recorded broker child independently of stale or missing claims", async () => {
		const { tabId, index, handle } = await restartedWithRecordedHost();
		const entry = index.get(tabId);
		assert.ok(entry);
		const generation = entry.ownership?.ownerGeneration;
		assert.ok(generation);

		const observed = (ownerGeneration: string): ObservedClaim => ({
			claimPath: "claims/session.claim",
			normalizedIdentity: "identity",
			verifiable: true,
			ownerGeneration,
			holderId: "holder-of-record",
			identity: null,
			pid: 1,
			createdAt: "2026-09-24T10:00:00.000Z",
		});
		const pin = provenPin(handle);
		const classify = (claim: ObservedClaim | null, host: OmpHostHandle = handle) =>
			classifySessionAvailability({
				entry,
				fileExists: true,
				claim,
				localLive: false,
				verdict: { kind: "attachable", host, pin, detail: "same pid, same broker child" },
			});

		const ours = classify(observed(generation));
		assert.equal(ours.availability, "live");
		assert.deepEqual(ours.attachableHost?.rpc, handle.rpc);
		assert.equal(ours.attachPin, pin, "the transport a verdict proved is published with its host");

		assert.deepEqual(classify(null).attachableHost, handle, "missing claims do not undo positive exact-broker identity");
		const foreign = classify(observed(createOwnerGeneration()));
		assert.deepEqual(foreign.attachableHost, handle, "claim acquisition separately excludes only verified-live rivals");

		// A host that does not match the recorded pid is only a live conflict.
		const mismatched = classify(observed(generation), { ...handle, pid: 999 });
		assert.equal(mismatched.availability, "live");
		assert.equal(mismatched.attachableHost, null);
		assert.match(mismatched.detail, /Not attaching/);
	});

});

// ── Imported history is a row like any other ────────────────────────────────

/**
 * A History click registers the exact file and opens the normal GUI for it: one
 * tab per file, one writer per file across extension windows, and the same
 * resume/attach behaviour after a restart. Import provenance still keeps the
 * destructive paths off a file this extension did not create.
 */
describe("imported history sessions", () => {
	it("opens an imported row through the same claim, launch and exact path as a created one", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-IMPORTED", cwd);
		const before = await readFile(file, "utf8");

		// What a History click does: register the discovered file, with the scope
		// it was discovered under.
		const imported = await openedImported(index, {
			sessionFile: file,
			cwd,
			scope: { profile: "work", sessionDir },
		});
		assert.equal(imported.origin, "imported");
		assert.equal(imported.availability, "saved");
		assert.equal(imported.sessionFile, file);
		assert.equal(imported.sessionId, "S-IMPORTED");
		assert.equal(imported.sessionDir, sessionDir);
		assert.equal(imported.scope.profile, "work");
		assert.equal(imported.scope.sessionDir, sessionDir);
		assert.ok(imported.ownership, "an imported row carries the generation it claims under");
		assert.equal(imported.host, null);

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-IMPORTED") });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(requests.length, 1, "the row is resumed, not shown as a document");
		assert.equal(requests[0]?.sessionFile, file, "the exact discovered file is resumed");
		assert.equal(requests[0]?.tabId, imported.tabId);
		assert.equal(requests[0]?.ownerGeneration, imported.ownership.ownerGeneration);
		assert.equal(requests[0]?.scope.profile, "work", "the discovered profile is kept");
		assert.equal(requests[0]?.scope.sessionDir, sessionDir, "the discovered session directory is kept");
		assert.deepEqual(report.restored.map(tab => tab.tabId), [imported.tabId]);
		assert.equal(report.conflicts.length, 0);
		assert.equal(index.get(imported.tabId)?.availability, "live");
		assert.equal((await readClaim(claimDir, file))?.ownerGeneration, imported.ownership.ownerGeneration);
		assert.equal(await readFile(file, "utf8"), before, "the transcript is never written by this extension");
	});

	it("reveals the same tab on a repeated click instead of starting a second host", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-REPEAT", cwd);

		const imported = await index.trackSession({ sessionFile: file, cwd });
		const clickedAgain = await index.trackSession({ sessionFile: file, cwd });
		assert.equal(clickedAgain.tabId, imported.tabId, "one tab per exact session file");
		assert.equal(index.list().length, 1);
		assert.equal(clickedAgain.ownership?.ownerGeneration, imported.ownership?.ownerGeneration);

		const first = recordingLauncher({ state: "running", host: runningHandle("S-REPEAT") });
		const opened = await index.restore(imported.tabId, { reconciler: noRecordedHost, launcher: first.launcher });
		assert.equal(opened.status, "restored");
		assert.equal(first.requests.length, 1);

		const again = recordingLauncher({ state: "running", host: runningHandle("S-REPEAT") });
		const focused = await index.restore(imported.tabId, { reconciler: noRecordedHost, launcher: again.launcher });
		assert.equal(focused.status, "attached", "the second click finds the tab this window already runs");
		assert.equal(again.requests.length, 0, "and starts no second writer");
	});

	it("resumes the exact file after a restart", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const file = await makeSessionFile(sessionDir, "S-RESTART", cwd);
		// A window whose extension host is gone: the claim and the recorded host
		// outlive it, which is exactly the situation a restart reconciles.
		const first = indexFor(store, claimDir, DEAD_WINDOW);
		const handle = runningHandle("S-RESTART");
		const imported = await openedImported(first, { sessionFile: file, cwd, scope: { profile: "work", sessionDir } });
		const started = recordingLauncher({ state: "running", host: handle });
		await first.restoreAll({ reconciler: noRecordedHost, launcher: started.launcher });
		assert.equal(started.requests.length, 1);

		// The persisted snapshot is all a new window sees.
		const restarted = indexFor(store, claimDir);
		const entry = restarted.get(imported.tabId);
		assert.ok(entry);
		assert.equal(entry.origin, "imported");
		assert.equal(entry.sessionFile, file, "the exact path is restored, never recomputed");
		assert.equal(entry.scope.profile, "work");
		assert.equal(entry.scope.sessionDir, sessionDir);
		assert.equal(entry.host?.pid, handle.pid, "the recorded host survives the restart");

		const resumed = recordingLauncher({ state: "running", host: runningHandle("S-RESTART") });
		const report = await restarted.restoreAll({ reconciler: recordedHostGone, launcher: resumed.launcher });

		assert.equal(resumed.requests.length, 1, "a row whose own writer is proven gone resumes again");
		assert.equal(resumed.requests[0]?.sessionFile, file, "and resumes the exact file it was imported from");
		assert.deepEqual(report.restored.map(tab => tab.tabId), [imported.tabId]);
		assert.equal(restarted.get(imported.tabId)?.availability, "live");
	});

	it("attaches to the exact extension host it recorded instead of starting a second one", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const file = await makeSessionFile(sessionDir, "S-ATTACH-IMPORTED", cwd);
		const first = indexFor(store, claimDir, DEAD_WINDOW);
		const handle = runningHandle("S-ATTACH-IMPORTED");
		const imported = await openedImported(first, { sessionFile: file, cwd });
		const started = recordingLauncher({ state: "running", host: handle });
		await first.restoreAll({ reconciler: noRecordedHost, launcher: started.launcher });
		assert.equal(started.requests.length, 1);

		const restarted = indexFor(store, claimDir);
		const { launcher, requests, attachRequests } = attachingLauncher({ state: "attached", host: handle });
		const report = await restarted.restoreAll({ reconciler: attachableHost(handle), launcher });

		assert.equal(requests.length, 0, "attaching never starts a second process");
		assert.equal(attachRequests.length, 1);
		assert.equal(attachRequests[0]?.sessionFile, file);
		assert.equal(attachRequests[0]?.recordedHost.pid, handle.pid);
		assert.deepEqual(attachRequests[0]?.recordedHost.rpc, handle.rpc);
		assert.deepEqual(report.attached.map(tab => tab.tabId), [imported.tabId]);
		assert.equal(report.restored.length, 0);
		assert.equal(restarted.get(imported.tabId)?.availability, "live");
	});

	it("converges two clicks on one History row on one tab", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-RACE", cwd);

		// Both clicks pass the idempotence lookup before either has read the header,
		// so only the lookup repeated after that read keeps them on one tab.
		const [first, second] = await Promise.all([
			index.trackSession({ sessionFile: file, cwd }),
			index.trackSession({ sessionFile: file, cwd }),
		]);

		assert.equal(first.tabId, second.tabId);
		assert.equal(index.list().length, 1, "one file is one tab");
		assert.equal(index.list()[0]?.tabId, first.tabId);
	});

	it("refuses a second writer while another extension window holds the claim", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-RIVAL", cwd);
		const imported = await openedImported(index, { sessionFile: file, cwd });
		assert.ok(imported.ownership);
		// Another window of one workspace reads the same persisted row and presents
		// the same owner generation; its live holder is what names the rival.
		const rival = await acquireClaim(claimDir, file, imported.ownership.ownerGeneration, createClaimHolder(process.pid));
		const before = await readClaim(claimDir, file);

		try {
			const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-RIVAL") });
			const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

			assert.equal(requests.length, 0, "a file another window still holds is never raced with a launch");
			assert.deepEqual(report.conflicts.map(conflict => conflict.kind), ["claim-conflict"]);
			assert.deepEqual(await readClaim(claimDir, file), before, "the rival window's claim is left alone");
			assert.equal(index.get(imported.tabId)?.availability, "live");
			assert.equal(index.get(imported.tabId)?.sessionFile, file, "and the tab identity is kept");
		} finally {
			await rival.release();
		}
	});

	it("releases the claim of a confirmed-stopped imported host, and lets the row be forgotten", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-STOPPED", cwd);
		const imported = await openedImported(index, { sessionFile: file, cwd });
		const { launcher } = recordingLauncher({ state: "running", host: runningHandle("S-STOPPED") });
		await index.restoreAll({ reconciler: noRecordedHost, launcher });
		assert.ok(await readClaim(claimDir, file));

		const closed = await index.closeSession(imported.tabId, { confirmedStopped: true });

		assert.equal(closed.released, true);
		assert.equal(await readClaim(claimDir, file), null, "a confirmed stop releases the claim the row took");
		assert.equal(index.get(imported.tabId)?.availability, "saved");
		assert.equal(index.get(imported.tabId)?.host, null);

		const removed = await index.remove(imported.tabId);
		assert.equal(removed.removed, true, "a stopped imported row is a bookmark, and a bookmark can be dropped");
		assert.equal(await pathExists(file), true, "forgetting never removes the file");
	});



});

// ── A launch attempt with no recorded outcome ───────────────────────────────

/**
 * The window between starting a native process and reading its outcome is the one
 * place an attempt can leave no trace. What is defended here is that it cannot
 * leave a row that looks like one that never launched: the attempt is durable
 * before the launcher runs, an attempt that cannot be recorded never runs, and a
 * row left holding an identity-less attempt is never accepted as free.
 */
describe("a launch attempt whose outcome was never recorded", () => {
	it("records the attempt on disk before the launcher is asked to start anything", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-PENDING", cwd);
		const imported = await index.trackSession({ sessionFile: file, cwd });

		const seenAtLaunch: (RecordedHost | null)[] = [];
		const launcher: OmpHostLauncher = {
			async launch() {
				const snapshot = store.value as { entries: { host: RecordedHost | null }[] };
				seenAtLaunch.push(snapshot.entries[0]?.host ?? null);
				return { state: "unconfirmed", reason: "the window died before the host reported its identity" };
			},
			async attach() {
				return { state: "unavailable", reason: "attach is not scripted for this test" };
			},
		};

		const outcome = await index.restore(imported.tabId, { reconciler: noRecordedHost, launcher });

		assert.ok(outcome.status === "failed");
		assert.equal(outcome.kind, "launch-failed");
		const atLaunch = seenAtLaunch[0] ?? null;
		assert.ok(atLaunch !== null, "the attempt is persisted before the launcher can start a process");
		assert.equal(atLaunch.pid, null);
		assert.equal(atLaunch.instanceId, null);
		assert.equal(index.get(imported.tabId)?.availability, "saved");
		assert.equal(await readClaim(claimDir, file), null, "unconfirmed launch does not leave a live-holder veto");
	});

	it("starts no host when the attempt cannot be recorded", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new FailingStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-UNRECORDED", cwd);
		const imported = await index.trackSession({ sessionFile: file, cwd });
		assert.ok(index.persistError !== null, "the fixture's writes never land");

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-UNRECORDED") });
		const outcome = await index.restore(imported.tabId, { reconciler: noRecordedHost, launcher });

		assert.ok(outcome.status === "failed");
		assert.equal(outcome.kind, "index-error");
		assert.equal(requests.length, 0, "an attempt that cannot be recorded is never started");
		assert.equal(index.get(imported.tabId)?.availability, "failed");
		assert.equal(await readClaim(claimDir, file), null, "the claim this pass took guarded nothing and goes back");
	});

});

// ── Upgrade migration ───────────────────────────────────────────────────────

describe("persisted rows from earlier versions", () => {
	it("keeps an imported row resumable, and keeps its recorded host and scope", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const file = await makeSessionFile(sessionDir, "S-LEGACY", cwd);
		// The row a version without `origin` persisted for a file it imported and
		// then launched: a recorded host, a claim generation, no draft identity.
		store.value = {
			version: 1,
			activeTabId: "tab:legacy",
			nextOrdinal: 2,
			entries: [
				{
					tabId: "tab:legacy",
					sessionFile: file,
					sessionId: "S-LEGACY",
					cwd: normalizeWorkspaceDirectory(cwd),
					scope: { profile: "work", sessionDir },
					sessionDir,
					ownership: { ownerGeneration: "generation-legacy", draftIdentity: null, releasedAt: null },
					host: {
						pid: 4242,
						instanceId: "host-legacy",
						generation: 1,
						sessionId: "S-LEGACY",
						startedAt: "2026-09-24T10:00:00.000Z",
					},
					createdAt: "2026-09-24T10:00:00.000Z",
					lastActiveAt: "2026-09-24T10:05:00.000Z",
					ordinal: 1,
					availability: "live",
					detail: "Native host launched from the indexed session.",
				},
			],
		};

		const restarted = indexFor(store, claimDir, DEAD_WINDOW);
		const entry = restarted.get("tab:legacy");
		assert.ok(entry);
		assert.equal(entry.origin, "imported", "a row with no reserved draft identity was imported, not created");
		assert.equal(entry.availability, "live", "the recorded state is kept, not rewritten to read-only");
		assert.equal(entry.tabId, "tab:legacy", "the tab identity is preserved");
		assert.equal(entry.sessionFile, file);
		assert.equal(entry.scope.profile, "work");
		assert.equal(entry.scope.sessionDir, sessionDir);
		assert.equal(entry.ownership?.ownerGeneration, "generation-legacy", "the claim generation is not discarded");
		assert.equal(entry.host?.pid, 4242, "the recorded host is not discarded");

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-LEGACY") });
		const report = await restarted.restoreAll({ reconciler: recordedHostGone, launcher });
		assert.equal(requests.length, 1, "an imported row imported before the upgrade resumes like any other");
		assert.equal(requests[0]?.sessionFile, file);
		assert.deepEqual(report.restored.map(tab => tab.tabId), ["tab:legacy"]);
		assert.equal(restarted.list().length, 1, "the migrated row is kept, not dropped");
	});

	it("puts a row an earlier version forced read-only back on the resume path", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const file = await makeSessionFile(sessionDir, "S-READONLY", cwd);
		store.value = {
			version: 1,
			activeTabId: "tab:readonly",
			nextOrdinal: 2,
			entries: [
				{
					tabId: "tab:readonly",
					origin: "unmanaged",
					sessionFile: file,
					sessionId: "S-READONLY",
					cwd: normalizeWorkspaceDirectory(cwd),
					scope: { profile: null, sessionDir },
					sessionDir,
					ownership: null,
					host: null,
					createdAt: "2026-09-24T10:00:00.000Z",
					lastActiveAt: "2026-09-24T10:05:00.000Z",
					ordinal: 1,
					availability: "read-only",
					detail: "shown read-only by an earlier version",
					runIntent: "running",
				},
			],
		};

		const restarted = indexFor(store, claimDir);
		const entry = restarted.get("tab:readonly");
		assert.ok(entry);
		assert.equal(entry.origin, "imported", "the value an earlier version wrote still means imported");
		assert.equal(entry.availability, "saved", "read-only is not a state this version has");
		assert.equal(entry.tabId, "tab:readonly");
		assert.equal(entry.sessionFile, file);
		assert.equal(entry.scope.sessionDir, sessionDir);
		assert.equal(entry.ownership, null, "no generation is invented at load");

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-READONLY") });
		const report = await restarted.restoreAll({ reconciler: noRecordedHost, launcher });
		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.sessionFile, file, "the file the old row recorded is the one resumed");
		assert.deepEqual(report.restored.map(tab => tab.tabId), ["tab:readonly"]);

		// The generation the claim was taken under is on disk before the claim, so
		// a reloaded window recognises that claim as its own.
		const generation = restarted.get("tab:readonly")?.ownership?.ownerGeneration ?? null;
		assert.ok(generation);
		assert.equal((await readClaim(claimDir, file))?.ownerGeneration, generation);
		assert.equal(indexFor(store, claimDir).get("tab:readonly")?.ownership?.ownerGeneration, generation);
	});

	it("keeps a draft row written before the field existed resumable", async () => {
		const { claimDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		store.value = {
			version: 1,
			activeTabId: "tab:draft",
			nextOrdinal: 2,
			entries: [
				{
					tabId: "tab:draft",
					sessionFile: null,
					sessionId: null,
					cwd: normalizeWorkspaceDirectory(cwd),
					scope: { profile: null, sessionDir: null },
					sessionDir: null,
					ownership: { ownerGeneration: "generation-draft", draftIdentity: "draft:legacy", releasedAt: null },
					host: null,
					createdAt: "2026-09-24T10:00:00.000Z",
					lastActiveAt: "2026-09-24T10:05:00.000Z",
					ordinal: 1,
					availability: "draft",
					detail: "Reserved draft identity; no session file has been written yet.",
				},
			],
		};

		const index = indexFor(store, claimDir);
		assert.equal(index.get("tab:draft")?.origin, "extension", "a reserved draft identity proves this extension created the tab");

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-DRAFT") });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher, restoreDrafts: true });

		assert.equal(requests.length, 1);
		assert.equal(requests[0]?.sessionFile, null, "a draft starts a fresh session, not a resume");
		assert.equal(report.restored.length, 1);
	});



	// The value an earlier version's root-stripping normalizer produced: a bare
	// drive on Windows, an empty string for the POSIX root.
	const ambiguous = process.platform === "win32" ? "C:" : "";

	it("keeps an ambiguous legacy cwd, and refuses its launch because nothing can repair it", async () => {
		const { claimDir, sessionDir } = await tempWorkspace();
		const store = new TestStore();
		// The session file exists but records no cwd of its own, so it is not
		// evidence of any directory the row could be opened in.
		const file = path.join(sessionDir, "2026-09-24T10-00-00_S-ROOTLESS.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "S-ROOTLESS" })}\n`, "utf8");
		store.value = {
			version: 1,
			activeTabId: "tab:rootless",
			nextOrdinal: 2,
			entries: [
				{
					tabId: "tab:rootless",
					sessionFile: file,
					sessionId: "S-ROOTLESS",
					cwd: ambiguous,
					scope: { profile: null, sessionDir },
					sessionDir,
					ownership: { ownerGeneration: "generation-rootless", draftIdentity: null, releasedAt: null },
					host: null,
					createdAt: "2026-09-24T10:00:00.000Z",
					lastActiveAt: "2026-09-24T10:05:00.000Z",
					ordinal: 1,
					availability: "saved",
					detail: "a row from a version that stripped the root off a cwd",
					runIntent: "running",
				},
			],
		};

		const index = indexFor(store, claimDir);
		assert.equal(index.loadError, null, "one unusable cwd must not discard the whole snapshot");
		assert.equal(index.list().length, 1, "the row survives to be reported instead of silently dropped");
		assert.equal(index.get("tab:rootless")?.cwd, ambiguous, "the ambiguous value is never resolved or migrated");

		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-ROOTLESS") });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(requests.length, 0, "guessing a folder is never a launch, so no host is started");
		assert.deepEqual(report.failures.map(failure => failure.kind), ["ambiguous-cwd"]);
		assert.equal(index.get("tab:rootless")?.availability, "failed");
		assert.equal(await readClaim(claimDir, file), null, "the refusal happens before any claim is taken");
		assert.match(report.failures[0]?.detail ?? "", /is not an absolute directory/);
		assert.equal(index.get("tab:rootless")?.cwd, ambiguous, "a refusal never rewrites the row it refused");
	});

	it("repairs an ambiguous legacy cwd only from the session file's own header", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		// The same broken row, but this time OMP's own header records the
		// directory the session actually ran in — the independent evidence that
		// is the only thing allowed to replace the stored value.
		const file = await makeSessionFile(sessionDir, "S-REPAIRABLE", cwd);
		store.value = {
			version: 1,
			activeTabId: "tab:repairable",
			nextOrdinal: 2,
			entries: [
				{
					tabId: "tab:repairable",
					sessionFile: file,
					sessionId: "S-REPAIRABLE",
					cwd: ambiguous,
					scope: { profile: null, sessionDir },
					sessionDir,
					ownership: { ownerGeneration: "generation-repairable", draftIdentity: null, releasedAt: null },
					host: null,
					createdAt: "2026-09-24T10:00:00.000Z",
					lastActiveAt: "2026-09-24T10:05:00.000Z",
					ordinal: 1,
					availability: "saved",
					detail: "a row from a version that stripped the root off a cwd",
					runIntent: "running",
				},
			],
		};

		const index = indexFor(store, claimDir);
		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-REPAIRABLE") });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher });

		assert.equal(requests.length, 1, "the header's absolute directory is evidence enough to open the session");
		assert.equal(
			requests[0]?.cwd,
			normalizeWorkspaceDirectory(cwd),
			"the host runs in the directory the session file records, not in this process's folder",
		);
		assert.deepEqual(report.restored.map(tab => tab.tabId), ["tab:repairable"]);
		assert.equal(
			indexFor(store, claimDir).get("tab:repairable")?.cwd,
			normalizeWorkspaceDirectory(cwd),
			"the repair is persisted once instead of being repeated on every launch",
		);
	});

	it("derives the origin of a row written before the field existed", () => {
		const ownership = { ownerGeneration: "g", draftIdentity: null, releasedAt: null };
		assert.equal(resolveSessionOrigin(undefined, null), "imported");
		assert.equal(resolveSessionOrigin(undefined, ownership), "imported");
		assert.equal(resolveSessionOrigin(undefined, { ...ownership, draftIdentity: "draft:1" }), "extension");
		assert.equal(resolveSessionOrigin("extension", null), "extension");
		assert.equal(resolveSessionOrigin("imported", { ...ownership, draftIdentity: "draft:1" }), "imported");
		// The value an earlier version wrote means the same thing as `imported`.
		assert.equal(resolveSessionOrigin("unmanaged", ownership), "imported");
		// An unexpected value is never read as "this extension created it".
		assert.equal(resolveSessionOrigin("something-else", ownership), "imported");
		assert.equal(resolveSessionOrigin("something-else", { ...ownership, draftIdentity: "draft:1" }), "extension");
	});
});

// ── Session file header ─────────────────────────────────────────────────────

describe("session file header", () => {
	/** The physical shape OMP 18.3.0 writes: title slot, then the session header. */
	function body(options: { slotTitle?: string; headerTitle?: string; extra?: string[] }): string {
		const slot = JSON.stringify({
			type: "title",
			v: 1,
			title: options.slotTitle ?? "",
			source: "auto",
			updatedAt: "2026-09-24T10:00:00.000Z",
			pad: " ".repeat(8),
		});
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "S-HEADER",
			timestamp: "2026-09-24T10:00:00.000Z",
			cwd: "C:\\projects\\one",
			...(options.headerTitle === undefined ? {} : { title: options.headerTitle }),
		});
		return [slot, header, ...(options.extra ?? [])].join("\n") + "\n";
	}

	it("reads the title OMP keeps in the fixed-width slot", () => {
		assert.deepEqual(parseSessionFileHeader(body({ slotTitle: "View omp stats" })), {
			sessionId: "S-HEADER",
			cwd: "C:\\projects\\one",
			title: "View omp stats",
		});
	});

	it("prefers the title slot, including an explicit cleared name, and reads legacy header titles", () => {
		// OMP's current slot is authoritative even when it clears an older header name.
		assert.equal(parseSessionFileHeader(body({ slotTitle: "renamed", headerTitle: "old" }))?.title, "renamed");
		assert.equal(parseSessionFileHeader(body({ headerTitle: "old header name" }))?.title, null);
		assert.equal(parseSessionFileHeader(JSON.stringify({ type: "session", id: "legacy", title: "Legacy title" }))?.title, "Legacy title");
		// An unnamed session reports no title at all rather than an empty one.
		assert.equal(parseSessionFileHeader(body({}))?.title, null);
	});

	it("reports no title for a candidate the slot never named", () => {
		// A `title_change` entry is a log entry, not the slot: reading it would
		// report a title OMP's own listing would not.
		const withChange = body({
			extra: [
				JSON.stringify({
					type: "title_change",
					id: "0b05dd58",
					parentId: "aacc56ca",
					timestamp: "2026-09-24T10:05:00.000Z",
					title: "appended by a rename",
					source: "user",
				}),
			],
		});
		assert.equal(parseSessionFileHeader(withChange)?.title, null);
		// A slot from a future version is not read as this one.
		const futureSlot = `${JSON.stringify({ type: "title", v: 2, title: "from the future" })}\n${JSON.stringify({
			type: "session",
			id: "S-FUTURE",
			cwd: "C:\\projects\\one",
		})}\n`;
		assert.equal(parseSessionFileHeader(futureSlot)?.title, null);
	});

	it("needs a session header, not only a title slot", () => {
		assert.equal(parseSessionFileHeader(""), null);
		assert.equal(parseSessionFileHeader(`${JSON.stringify({ type: "title", v: 1, title: "orphan" })}\n`), null);
	});

	it("summarizes only the first user prompt and leaves native and user titles authoritative", () => {
		const messages = [
			JSON.stringify({ type: "message", message: { role: "assistant", content: "Not a prompt" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "  Fix the login\n layout  " }, { type: "image", data: "ignored" }] } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "Not the first prompt" } }),
		];
		assert.equal(parseSessionFileHeader(body({ extra: messages }))?.promptTitle, "Fix the login layout");
		assert.equal(parseSessionFileHeader(body({ slotTitle: "User title", extra: messages }))?.title, "User title");
		assert.equal(parseSessionFileHeader(body({ slotTitle: "User title", extra: messages }))?.promptTitle, undefined);
		const long = parseSessionFileHeader(body({ extra: [JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(100) } })] }))?.promptTitle;
		assert.equal(long?.length, 60);
	});

	it("finds the first prompt even beyond the bounded header prefix", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-prompt-title-"));
		try {
			const file = path.join(root, "session.jsonl");
			await writeFile(file, body({ extra: [
				JSON.stringify({ type: "metadata", content: "x".repeat(70_000) }),
				JSON.stringify({ type: "message", message: { role: "user", content: "A descriptive session" } }),
			] }));
			assert.equal((await readSessionFileHeader(file))?.promptTitle, "A descriptive session");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});

describe("session file activity", () => {
	/** One entry as OMP 18.6.3 serializes it: `type`, then `id`, `parentId`, `timestamp`, then the payload. */
	function entry(type: string, timestamp: string, payload: Record<string, unknown> = {}): string {
		return JSON.stringify({ type, id: timestamp.slice(11, 19), parentId: null, timestamp, ...payload });
	}
	/** A custom message as OMP writes it: the payload comes first and the common fields last. */
	function customMessage(timestamp: string, content: string): string {
		return JSON.stringify({ type: "custom_message", customType: "async-result", content, display: true, details: { timestamp: "1999-01-01T00:00:00.000Z" }, attribution: "agent", id: "c1", parentId: null, timestamp });
	}
	const head = [
		JSON.stringify({ type: "title", v: 1, title: "Named" }).padEnd(255, " "),
		JSON.stringify({ type: "session", version: 3, id: "S-ACTIVITY", timestamp: "2026-10-08T09:00:00.000Z", cwd: "C:\\projects\\one" }),
	];

	async function withFile(lines: readonly string[], check: (file: string) => Promise<void>, trailingNewline = true): Promise<void> {
		const root = await mkdtemp(path.join(tmpdir(), "omp-activity-"));
		try {
			const file = path.join(root, "session.jsonl");
			await writeFile(file, `${lines.join("\n")}${trailingNewline ? "\n" : ""}`);
			await check(file);
		} finally { await rm(root, { recursive: true, force: true }); }
	}

	it("reports the last conversation entry, not the bookkeeping OMP appends after it", async () => {
		await withFile([
			...head,
			entry("model_change", "2026-10-08T09:00:01.000Z", { model: "anthropic/claude" }),
			entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "user", content: "hello" } }),
			entry("message", "2026-10-08T10:01:00.000Z", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
			// A host exit, a resume and a model switch: none of them is the conversation.
			entry("custom", "2026-10-08T12:00:00.000Z", { customType: "session_exit", data: { reason: "dispose", kind: "normal" } }),
			entry("thinking_level_change", "2026-10-08T12:05:00.000Z", { thinkingLevel: "high" }),
			entry("service_tier_change", "2026-10-08T12:05:00.000Z", { serviceTier: null }),
			entry("model_change", "2026-10-08T12:06:00.000Z", { model: "openai/gpt" }),
		], async file => {
			assert.equal((await readSessionFileActivity(file))?.lastConversationAt, "2026-10-08T10:01:00.000Z");
		});
	});

	it("reads entries across chunk boundaries, including a payload-first custom message and an unterminated last line", async () => {
		const bulky = (minute: number) => entry("custom", `2026-10-08T11:${String(minute).padStart(2, "0")}:00.000Z`, {
			customType: "tool_execution_start", data: { args: "x".repeat(30_000) },
		});
		await withFile([
			...head,
			entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "assistant", content: "y".repeat(150_000) } }),
			customMessage("2026-10-08T10:05:00.000Z", "z".repeat(200_000)),
			bulky(1), bulky(2), bulky(3), bulky(4), bulky(5),
			entry("custom", "2026-10-08T12:00:00.000Z", { customType: "session_exit" }).slice(0, 40),
		], async file => {
			assert.equal((await readSessionFileActivity(file))?.lastConversationAt, "2026-10-08T10:05:00.000Z");
		}, false);
		await withFile([
			...head,
			entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "assistant", content: "y".repeat(150_000) } }),
			bulky(1), bulky(2), bulky(3),
		], async file => {
			assert.equal((await readSessionFileActivity(file))?.lastConversationAt, "2026-10-08T10:00:00.000Z");
		});
	});

	it("tells a file without conversation from a missing one, and re-reads only a changed file", async () => {
		await withFile([...head, entry("model_change", "2026-10-08T09:00:01.000Z", { model: "anthropic/claude" })], async file => {
			const empty = await readSessionFileActivity(file);
			assert.equal(empty?.lastConversationAt, null);
			assert.equal(await readSessionFileActivity(file, empty), empty, "an unchanged file is not read again");
			await writeFile(file, `${entry("message", "2026-10-08T10:00:00.000Z", { message: { role: "user", content: "next" } })}\n`, { flag: "a" });
			assert.equal((await readSessionFileActivity(file, empty))?.lastConversationAt, "2026-10-08T10:00:00.000Z");
			assert.equal(await readSessionFileActivity(path.join(path.dirname(file), "missing.jsonl")), null);
		});
	});
});

// ── Session deletion ────────────────────────────────────────────────────────

/**
 * The artifacts directory and one failed-rewrite leftover OMP keeps beside a
 * transcript. OMP's own `/session delete` removes both together with the file
 * (pi-coding-agent `src/session/session-storage.ts`, `deleteSessionWithArtifacts`).
 */
async function materializeArtifacts(file: string): Promise<{ artifactsDir: string; backup: string }> {
	const artifactsDir = file.slice(0, -".jsonl".length);
	await mkdir(artifactsDir, { recursive: true });
	await writeFile(path.join(artifactsDir, "draft.txt"), "draft", "utf8");
	const backup = `${file}.1234567.bak`;
	await writeFile(backup, "stale bytes", "utf8");
	return { artifactsDir, backup };
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

function deletionOptions(
	index: SessionIndex,
	reconciler: OwnerReconciler,
	windowHostRunning = false,
): SessionDeletionOptions {
	return { index, reconciler, windowHostRunning: () => windowHostRunning };
}

describe("session deletion", () => {
	it("deletes a proven-dead session's transcript, artifacts and leftovers, and drops the row", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-DELETE", cwd);
		const entry = await managedSession(index, file, cwd);
		const { artifactsDir, backup } = await materializeArtifacts(file);

		const options = deletionOptions(index, noRecordedHost);
		const inspection = await inspectSessionDeletion(entry.tabId, options);
		assert.ok(inspection, "an indexed tab is always inspectable");
		assert.equal(inspection.allowed, true, inspection.detail);
		assert.deepEqual(
			inspection.targets.map(target => target.path).sort(),
			[artifactsDir, backup, file].sort(),
			"the confirmation names every path the removal would delete",
		);

		const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);

		assert.equal(result.deleted, true, result.detail);
		assert.equal(result.kind, null);
		assert.deepEqual(result.failures, []);
		assert.equal(result.rowRemoved, true);
		assert.equal(await pathExists(file), false, "the transcript is gone");
		assert.equal(await pathExists(artifactsDir), false, "the artifacts directory goes with it");
		assert.equal(await pathExists(backup), false, "a leftover rewrite backup cannot resurrect the session");
		assert.equal(index.get(entry.tabId), null, "the launcher row is dropped");
		assert.equal(await readClaim(claimDir, file), null, "no claim is left on a deleted session");
	});

	it("deletes an imported conversation's own files under the same exclusive transaction", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-IMPORTED", cwd);
		const imported = await index.trackSession({ sessionFile: file, cwd });
		const { artifactsDir, backup } = await materializeArtifacts(file);
		let asked = false;
		const spy: OwnerReconciler = {
			async reconcile() {
				asked = true;
				return { kind: "free", evidence: [{ kind: "no-recorded-host" }] };
			},
		};

		const options = deletionOptions(index, spy);
		const inspection = await inspectSessionDeletion(imported.tabId, options);
		assert.equal(inspection?.allowed, true, inspection?.detail);
		assert.deepEqual(
			inspection?.targets.map(target => target.path).sort(),
			[artifactsDir, backup, file].sort(),
			"the same target family is named for an imported row",
		);
		// Provenance does not change eligibility (ADR-0027), but the limitation is
		// still stated where the user confirms it.
		assert.ok(
			inspection?.notes.some(note => note.includes("native terminal")),
			"the confirmation warns about user-controlled native writers",
		);

		const result = await deleteManagedSession({ tabId: imported.tabId, sessionFile: file }, options);
		assert.equal(result.deleted, true, result.detail);
		assert.equal(result.kind, null);
		assert.equal(asked, true, "an imported row is reconciled like any other");
		assert.equal(await pathExists(file), false);
		assert.equal(await pathExists(artifactsDir), false);
		assert.equal(await pathExists(backup), false);
		assert.equal(index.get(imported.tabId), null, "the imported launcher row is dropped too");
	});

	it("deletes a discovered file that has no index row under its own exclusive claim", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-DISCOVERED", cwd);
		const { artifactsDir, backup } = await materializeArtifacts(file);

		const options = deletionOptions(index, noRecordedHost, false);
		const inspection = await inspectSessionDeletion({ sessionFile: file, profile: null }, options);
		assert.equal(inspection?.allowed, true, inspection?.detail);
		assert.equal(inspection?.tabId, null, "a discovered file has no row");

		const result = await deleteManagedSession({ sessionFile: file, profile: null }, options);
		assert.equal(result.deleted, true, result.detail);
		assert.equal(result.partial, false);
		assert.equal(result.rowRemoved, false, "there was no row to finalize");
		assert.equal(await pathExists(file), false);
		assert.equal(await pathExists(artifactsDir), false);
		assert.equal(await pathExists(backup), false);
		assert.equal(await readClaim(claimDir, file), null, "the deletion released its exclusive claim");
	});

	it("refuses a discovered file whose exact identity a live window holds", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-DISCOVERED-HELD", cwd);
		const rival = await acquireClaim(claimDir, file, createOwnerGeneration(), createClaimHolder());

		try {
			const options = deletionOptions(index, noRecordedHost, false);
			const result = await deleteManagedSession({ sessionFile: file, profile: null }, options);
			assert.equal(result.deleted, false);
			assert.equal(result.kind, "claim-held-elsewhere", result.detail);
			assert.equal(await pathExists(file), true, "a refusal deletes nothing");
		} finally {
			await rival.release();
		}
	});

	it("refuses while this window runs the host for the tab", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-LOCAL", cwd);
		const entry = await managedSession(index, file, cwd);
		const { artifactsDir } = await materializeArtifacts(file);

		const options = deletionOptions(index, noRecordedHost, true);
		const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);

		assert.equal(result.deleted, false);
		assert.equal(result.kind, "live-in-window");
		assert.equal(await pathExists(file), true);
		assert.equal(await pathExists(artifactsDir), true);
		assert.ok(index.get(entry.tabId));
	});

	it("refuses a live owner and one this window could reattach to", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-LIVE-ELSEWHERE", cwd);
		const entry = await managedSession(index, file, cwd);

		for (const reconciler of [liveHost, attachableHost(runningHandle("S-LIVE-ELSEWHERE"))]) {
			const options = deletionOptions(index, reconciler);
			const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);
			assert.equal(result.deleted, false);
			assert.equal(result.kind, "live-elsewhere", result.detail);
			assert.equal(await pathExists(file), true);
			assert.ok(index.get(entry.tabId));
		}
	});


	it("refuses while another owner generation holds the claim", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-FOREIGN-CLAIM", cwd);
		const entry = await managedSession(index, file, cwd);
		const foreign = await acquireClaim(claimDir, file, createOwnerGeneration(), createClaimHolder());

		try {
			const options = deletionOptions(index, noRecordedHost);
			const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);
			assert.equal(result.deleted, false);
			assert.equal(result.kind, "claim-held-elsewhere");
			assert.equal(await pathExists(file), true);
			assert.notEqual(await readClaim(claimDir, file), null, "the other owner keeps its claim");
			assert.ok(index.get(entry.tabId));
		} finally {
			await foreign.release();
		}
	});

	it("takes and releases this tab's own leftover claim while deleting", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-OWN-CLAIM", cwd);
		const entry = await managedSession(index, file, cwd);
		// The claim a window that died before releasing it left behind.
		const own = await acquireClaim(
			claimDir,
			file,
			entry.ownership?.ownerGeneration ?? createOwnerGeneration(),
			createClaimHolder(4194303),
		);

		const options = deletionOptions(index, releasedClaim);
		const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);

		assert.equal(result.deleted, true, result.detail);
		assert.equal(await readClaim(claimDir, file), null, "the adopted claim is given back");
		assert.equal(result.rowRemoved, true);
		// The deletion already released this claim, so a second release may fail; that is fine.
		await own.release().catch(() => undefined);
	});

	it("refuses a missing transcript, a draft and a path that is not a transcript", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);

		const file = await makeSessionFile(sessionDir, "S-MISSING", cwd);
		const entry = await managedSession(index, file, cwd);
		await rm(file);
		const options = deletionOptions(index, noRecordedHost);
		const missing = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);
		assert.equal(missing.deleted, false);
		assert.equal(missing.kind, "missing-file");
		assert.ok(index.get(entry.tabId), "the row survives its own missing file, as it does for a restore");

		const draft = await index.createDraft({ cwd });
		const draftInspection = await inspectSessionDeletion(draft.tabId, options);
		assert.equal(draftInspection?.allowed, false);
		assert.equal(draftInspection?.kind, "draft");
		assert.deepEqual(draftInspection?.targets, [], "a draft has no path to name in a confirmation");

		// A path OMP never names as a transcript is refused rather than derived
		// into some other directory by a blind suffix strip.
		const odd = path.join(sessionDir, "not-a-transcript.txt");
		await writeFile(odd, `${JSON.stringify({ type: "session", id: "S-ODD", cwd })}\n`, "utf8");
		const oddDraft = await index.createDraft({ cwd });
		assert.equal((await index.promoteDraft(oddDraft.tabId, odd)).status, "promoted");
		const oddResult = await deleteManagedSession({ tabId: oddDraft.tabId, sessionFile: odd }, options);
		assert.equal(oddResult.deleted, false);
		assert.equal(oddResult.kind, "unrecognized-file");
		assert.equal(await pathExists(odd), true);
	});

	it("refuses when the tab no longer points at the confirmed transcript", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-CONFIRMED", cwd);
		const other = await makeSessionFile(sessionDir, "S-OTHER", cwd);
		const entry = await managedSession(index, file, cwd);

		const result = await deleteManagedSession(
			{ tabId: entry.tabId, sessionFile: other },
			deletionOptions(index, noRecordedHost),
		);

		assert.equal(result.deleted, false);
		assert.equal(result.kind, "target-changed", result.detail);
		assert.equal(await pathExists(file), true);
		assert.equal(await pathExists(other), true);
		assert.ok(index.get(entry.tabId));
	});

	it("keeps the row when the transcript is still there after the removal", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-RESURRECTED", cwd);
		const entry = await managedSession(index, file, cwd);
		// The row-drop guard is exercised on its own: a tab whose file exists is
		// never dropped, whatever the deletion path believes.
		const dropped = await index.dropDeletedSession(entry.tabId, { sessionFile: file });
		assert.equal(dropped.removed, false);
		assert.ok(index.get(entry.tabId));

		const claim = await acquireClaim(
			claimDir,
			file,
			entry.ownership?.ownerGeneration ?? createOwnerGeneration(),
			createClaimHolder(),
		);
		try {
			await rm(file);
			const stillClaimed = await index.dropDeletedSession(entry.tabId, { sessionFile: file });
			assert.equal(stillClaimed.removed, false, "a claim that still stands keeps the row");
			assert.ok(index.get(entry.tabId));
		} finally {
			await claim.release();
		}
		await rm(file, { force: true });
		const afterRelease = await index.dropDeletedSession(entry.tabId, { sessionFile: file });
		assert.equal(afterRelease.removed, true);
		assert.equal(index.get(entry.tabId), null);
	});
});

// ── Two windows, one session ────────────────────────────────────────────────

/**
 * Two VS Code windows on one folder read the *same* persisted index and present
 * the *same* owner generation, so nothing in the row can tell them apart; only
 * the holder lease can. These tests exercise that deterministically with two
 * `SessionIndex` instances over one shared memento (as two windows have) and one
 * claim directory.
 */
describe("two windows of one workspace", () => {
	/** One window: its own index, its own claim storage, one shared memento. */
	function windowOn(store: SessionIndexStore, claimDir: string): SessionIndex {
		return indexFor(store, claimDir);
	}

	it("starts exactly one writer for one session, and only after the first window stopped", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const first = windowOn(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-WINDOWS", cwd);
		const entry = await managedSession(first, file, cwd);
		const second = windowOn(store, claimDir);
		assert.equal(
			second.get(entry.tabId)?.ownership?.ownerGeneration,
			entry.ownership?.ownerGeneration,
			"both windows persist and read one owner generation",
		);

		const one = recordingLauncher({ state: "running", host: runningHandle() });
		const firstPass = await first.restoreAll({ reconciler: noRecordedHost, launcher: one.launcher });
		assert.equal(firstPass.restored.length, 1);

		// The second window reconciles the very same row with a reconciler that
		// would free it, and must still not launch: another live holder has it.
		const two = recordingLauncher({ state: "running", host: runningHandle() });
		const secondPass = await second.restoreAll({ reconciler: noRecordedHost, launcher: two.launcher });

		assert.equal(two.requests.length, 0, "a second window must never start a second writer");
		assert.equal(two.attachRequests.length, 0);
		assert.equal(secondPass.restored.length, 0);
		assert.equal(secondPass.conflicts[0]?.kind, "claim-conflict");
		assert.equal(one.requests.length, 1, "the first window's single launch stands");
		assert.equal((await readClaim(claimDir, file))?.holderId, first.claimHolder.id);

		// Only the holder may release, so the second window cannot erase it.
		const refused = await second.closeSession(entry.tabId, { confirmedStopped: true });
		assert.equal(refused.released, false);
		assert.equal((await readClaim(claimDir, file))?.holderId, first.claimHolder.id, "the lease survives");

		// Once the first window's host is confirmed stopped and its lease is
		// released, the second window may take the session over.
		const stopped = await first.closeSession(entry.tabId, { confirmedStopped: true });
		assert.equal(stopped.released, true);
		const third = recordingLauncher({ state: "running", host: runningHandle() });
		const secondTry = await second.restoreAll({ reconciler: noRecordedHost, launcher: third.launcher });
		assert.equal(third.requests.length, 1);
		assert.equal(secondTry.restored.length, 1);
		assert.equal((await readClaim(claimDir, file))?.holderId, second.claimHolder.id);
	});

	it("refuses a deletion while the other window holds the session's lease", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const first = windowOn(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-WINDOWS-DELETE", cwd);
		const entry = await managedSession(first, file, cwd);
		await materializeArtifacts(file);
		const second = windowOn(store, claimDir);

		const one = recordingLauncher({ state: "running", host: runningHandle() });
		assert.equal((await first.restoreAll({ reconciler: noRecordedHost, launcher: one.launcher })).restored.length, 1);
		const claimBefore = await readClaim(claimDir, file);

		const options = deletionOptions(second, noRecordedHost);
		const inspection = await inspectSessionDeletion(entry.tabId, options);
		const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);

		// The reconciler says free and this row's generation is the one recorded,
		// so only the holder lease stands between this window and the deletion —
		// and it is refused before the confirmation, not after it.
		assert.equal(inspection?.allowed, false, "a rival window's lease is visible before the confirmation");
		assert.equal(inspection?.kind, "claim-held-elsewhere");
		assert.equal(result.deleted, false, "another live holder's session is never deleted");
		assert.equal(result.kind, "claim-held-elsewhere");
		assert.equal(await pathExists(file), true);
		assert.ok(second.get(entry.tabId) !== null, "the row survives a refused deletion");
		assert.deepEqual(await readClaim(claimDir, file), claimBefore, "the holder's lease is untouched");
	});
});

// ── Lifecycle coordination ──────────────────────────────────────────────────
//
// Operations on one tab (promotion, close, relaunch, row removal, deferred
// adoption, native deletion) await between reading and writing the tab's facts,
// so they must be ordered, never interleaved: whichever reached the tab's
// lifecycle first is the one the other observes.
//
// Both barriers below sit on real code paths rather than on injected callbacks:
// `HeldStore` parks a promotion inside its own claim work at its memento write,
// and `holdGate` keeps a tab's lifecycle held while the test queues the
// operations that must be ordered behind it.

describe("lifecycle coordination", () => {
	/**
	 * A draft row a reload left behind, whose launched host is proven gone: exactly
	 * the row a deferred pass reports startable and then adopts a file for.
	 */
	async function reloadedDraftWithADeadHost(): Promise<{
		readonly claimDir: string;
		readonly index: SessionIndex;
		readonly file: string;
		readonly identity: string;
		readonly tab: DeferredReconciliation;
	}> {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const first = indexFor(store, claimDir, DEAD_WINDOW);
		const draft = await first.createDraft({ cwd });
		const identity = draft.ownership?.draftIdentity;
		assert.ok(identity, "a draft always reserves a claim identity");
		const started = recordingLauncher({ state: "running", host: runningHandle("S-DRAFT") });
		assert.equal(
			(await first.restore(draft.tabId, { reconciler: noRecordedHost, launcher: started.launcher })).status,
			"restored",
		);
		const file = await makeSessionFile(sessionDir, "S-DRAFT", cwd);
		// The reload: the same durable row and claim, a fresh extension host, no live
		// record at all.
		const index = indexFor(store, claimDir);
		const report = await index.reconcileDeferred({ reconciler: recordedHostGone });
		const tab = report.reconciled[0];
		assert.ok(tab?.startable, "the dead host's row is startable again after the reload");
		return { claimDir, index, file, identity, tab };
	}

	it("waits for a promotion already inside its claim work, then releases the claim it took", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new HeldStore();
		const index = indexFor(store, claimDir);
		const draft = await index.createDraft({ cwd });
		const file = await makeSessionFile(sessionDir, "S-RACE", cwd);
		const identity = index.get(draft.tabId)?.ownership?.draftIdentity ?? null;
		assert.ok(identity !== null, "a draft always has a reserved identity");
		// This window runs a host for the tab, exactly as a launch leaves it: the
		// reserved draft identity is claimed by this window's holder.
		const started = recordingLauncher({ state: "running", host: runningHandle("S-RACE") });
		const restored = await index.restore(draft.tabId, { reconciler: noRecordedHost, launcher: started.launcher });
		assert.equal(restored.status, "restored");
		assert.ok((await readClaim(claimDir, identity)) !== null, "the running host holds the draft identity");

		// Park the promotion inside its own claim work: the entry is bound, the
		// canonical claim is taken and the draft identity released; what is still
		// open is the memento write.
		store.hold();
		const writeArrived = store.nextWrite();
		const promotion = index.promoteDraft(draft.tabId, file);
		await writeArrived;
		assert.equal(index.get(draft.tabId)?.sessionFile, file, "the promotion has committed its binding");
		assert.equal(await readClaim(claimDir, identity), null, "and retired the draft identity");
		assert.ok((await readClaim(claimDir, file)) !== null, "while holding the promoted one");

		// The terminal closes now. The close is one lifecycle operation of the same
		// tab, so it is queued behind the whole promotion — it cannot observe, or
		// act on, a half-migrated claim.
		let closeStarted = false;
		const close = index.lifecycle.run(draft.tabId, async lease => {
			closeStarted = true;
			return await index.closeSession(draft.tabId, { confirmedStopped: true }, lease);
		});
		// Let the close's own turn come: a queued operation cannot start, so this is
		// the assertion that fails if the promotion does not hold the tab.
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(closeStarted, false, "the close has not started while the promotion is inside its lifecycle");
		assert.equal(index.get(draft.tabId)?.ownership?.releasedAt, null, "and has recorded no release yet");
		assert.ok((await readClaim(claimDir, file)) !== null, "the promoted claim is still the promotion's");

		store.release();
		assert.equal((await promotion).status, "promoted");
		const closed = await close;
		assert.equal(closed.released, true, "the close takes over only after the promotion has settled");
		assert.equal(index.get(draft.tabId)?.sessionFile, file, "and keeps the file the promotion bound");
		assert.notEqual(index.get(draft.tabId)?.ownership?.releasedAt, null, "recording the confirmed stop");
		assert.equal(await readClaim(claimDir, file), null, "and releasing exactly that claim");
		assert.equal(index.get(draft.tabId)?.availability, "saved");

		// The later reopen resumes the same exact file, through the usual checks.
		const reopened = recordingLauncher({ state: "running", host: runningHandle("S-RACE") });
		const outcome = await index.restore(draft.tabId, { reconciler: releasedClaim, launcher: reopened.launcher });
		assert.equal(outcome.status, "restored");
		assert.equal(reopened.requests.length, 1, "one host, not two");
		assert.equal(reopened.requests[0]?.sessionFile, file, "started for the promoted file and nothing else");
		assert.ok((await readClaim(claimDir, file)) !== null, "and holding that file's claim again");
	});

	it("leaves the live record holding the promoted claim, and starts no second host for a queued relaunch", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new HeldStore();
		const index = indexFor(store, claimDir);
		const draft = await index.createDraft({ cwd });
		const file = await makeSessionFile(sessionDir, "S-LIVE", cwd);
		const identity = index.get(draft.tabId)?.ownership?.draftIdentity ?? null;
		assert.ok(identity !== null);
		const started = recordingLauncher({ state: "running", host: runningHandle("S-LIVE") });
		assert.equal((await index.restore(draft.tabId, { reconciler: noRecordedHost, launcher: started.launcher })).status, "restored");

		store.hold();
		const writeArrived = store.nextWrite();
		const promotion = index.promoteDraft(draft.tabId, file);
		await writeArrived;

		// A relaunch is queued behind the promotion. It must find the tab this
		// window already runs and adopt it, never start a second host.
		const relaunched = recordingLauncher({ state: "running", host: runningHandle("S-LIVE") });
		const relaunch = index.restore(draft.tabId, { reconciler: noRecordedHost, launcher: relaunched.launcher });
		store.release();

		assert.equal((await promotion).status, "promoted");
		assert.equal((await relaunch).status, "attached", "the tab is still this window's to run");
		assert.equal(relaunched.requests.length, 0, "a relaunch of a tab this window runs starts nothing");

		// The live record carries the *promoted* claim, not the retired draft handle:
		// releasing the close's claim is what frees the session file.
		assert.equal(await readClaim(claimDir, identity), null, "the draft identity stays retired");
		assert.ok((await readClaim(claimDir, file)) !== null, "the live record holds the canonical claim");
		const closed = await index.closeSession(draft.tabId, { confirmedStopped: true });
		assert.equal(closed.released, true);
		assert.equal(await readClaim(claimDir, file), null, "so the confirmed stop frees exactly that identity");
	});

	it("binds the exact file for a promotion queued behind the batch restore that launched its host", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const draft = await index.createDraft({ cwd });
		const file = await makeSessionFile(sessionDir, "S-BATCH", cwd);
		const identity = index.get(draft.tabId)?.ownership?.draftIdentity ?? null;
		assert.ok(identity !== null);
		const started = recordingLauncher({ state: "running", host: runningHandle("S-BATCH") });

		// The launch-time watch is detached in the extension, so it is started
		// without awaiting the restore: it must wait for it and then bind the exact
		// file, never deadlock behind the operation that started it.
		const batch = index.restoreAll({ reconciler: noRecordedHost, launcher: started.launcher, restoreDrafts: true });
		const promotion = index.promoteDraft(draft.tabId, file);

		const report = await batch;
		assert.equal(report.restored.length, 1, "the batch pass launched the draft's host");
		assert.equal((await promotion).status, "promoted");
		assert.equal(index.get(draft.tabId)?.sessionFile, file);
		assert.equal(started.requests.length, 1, "the detached watch started no second host");
		assert.equal(started.requests[0]?.sessionFile, null, "the host it watched was launched as a draft");
		assert.equal(await readClaim(claimDir, identity), null, "the retired draft identity");
		assert.ok((await readClaim(claimDir, file)) !== null, "is replaced by the promoted claim");
	});

	it("adopts nothing for a promotion queued behind the row's removal", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const draft = await index.createDraft({ cwd });
		const file = await makeSessionFile(sessionDir, "S-GONE", cwd);
		const identity = index.get(draft.tabId)?.ownership?.draftIdentity ?? null;
		assert.ok(identity !== null, "a draft always has a reserved identity");

		const gate = holdGate(index, draft.tabId);
		const removal = index.remove(draft.tabId);
		const promotion = index.promoteDraft(draft.tabId, file);
		gate.release();

		assert.equal((await removal).removed, true);
		const outcome = await promotion;
		assert.equal(outcome.status, "not-materialized", "a row that no longer exists cannot be promoted");
		assert.match(outcome.detail, /No indexed tab/);
		assert.equal(await readClaim(claimDir, file), null, "and no claim is taken for it");
		assert.equal(await readClaim(claimDir, identity), null);
		assert.equal(index.list().length, 0);
	});

	it("opens no detached row for a restore queued behind the row's removal", async () => {
		const { claimDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const draft = await index.createDraft({ cwd });
		const launcher = recordingLauncher({ state: "running", host: runningHandle("S-GONE") });

		const gate = holdGate(index, draft.tabId);
		const removal = index.remove(draft.tabId);
		// The restore captures the row before it queues, which is exactly the case
		// that must not start a host for a tab the index no longer has.
		const restore = index.restore(draft.tabId, { reconciler: noRecordedHost, launcher: launcher.launcher });
		gate.release();

		assert.equal((await removal).removed, true);
		const outcome = await restore;
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.kind, "index-error");
		assert.equal(launcher.requests.length, 0, "no host is started for a removed tab");
		assert.equal(index.get(draft.tabId), null);
	});

	it("refuses a deferred adoption while this window runs the host for the tab", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const draft = await index.createDraft({ cwd });
		const file = await makeSessionFile(sessionDir, "S-LATE", cwd);
		const identity = index.get(draft.tabId)?.ownership?.draftIdentity ?? null;
		assert.ok(identity !== null);
		const started = recordingLauncher({ state: "running", host: runningHandle("S-LATE") });
		assert.equal((await index.restore(draft.tabId, { reconciler: noRecordedHost, launcher: started.launcher })).status, "restored");

		// A deferred pass speaks for a host that is *gone*, so this rule is the
		// index's own and is evaluated before any authorization: the running host's
		// file may only be bound by that host's own promotion.
		const refused = await index.promoteDeferredDraft(draft.tabId, file, "not-this-row");
		assert.equal(refused.status, "not-materialized");
		assert.match(refused.detail, /running the host for tab/);
		assert.equal(index.get(draft.tabId)?.sessionFile, null, "the running host's file is not bound behind its back");
		assert.equal(await readClaim(claimDir, file), null, "and no canonical claim is taken for it");
		assert.ok((await readClaim(claimDir, identity)) !== null, "the identity the host runs under is untouched");
	});


	it("refuses a lease the tab's lifecycle is not holding", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const draft = await index.createDraft({ cwd });
		const file = await makeSessionFile(sessionDir, "S-LEASE", cwd);

		// A lease is the gate's own token: one the gate is not running, or one for
		// another tab, must never be accepted as "this tab is already held", because
		// that would skip the exclusion the lease exists to join.
		await assert.rejects(index.promoteDraft(draft.tabId, file, { tabId: draft.tabId }), /lifecycle lease/);
		await assert.rejects(index.closeSession(draft.tabId, { confirmedStopped: true }, { tabId: "tab:other" }), /lifecycle lease/);
		assert.equal(index.get(draft.tabId)?.sessionFile, null, "nothing was promoted through a fabricated lease");
		assert.equal(await readClaim(claimDir, file), null, "and no claim was taken for it");
	});

	it("adopts a dead host's file for the exact row the absence was proven for", async () => {
		const { claimDir, identity, index, file, tab } = await reloadedDraftWithADeadHost();

		const accepted = await index.promoteDeferredDraft(tab.tabId, file, tab.authorization);

		assert.equal(accepted.status, "promoted");
		assert.equal(index.get(tab.tabId)?.sessionFile, file, "the row is bound to the exact file that was adopted");
		assert.equal(index.get(tab.tabId)?.availability, "saved", "with nothing running for it");
		assert.ok((await readClaim(claimDir, file)) !== null, "the canonical claim is taken for that file");
		assert.equal(await readClaim(claimDir, identity), null, "and the reserved identity is retired");
	});

	it("refuses a deletion queued behind a restore instead of unlinking the transcript that host runs", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-DELETE-RACE", cwd);
		const entry = await managedSession(index, file, cwd);

		// The relaunch is ordered first, so this window runs the host by the time the
		// deletion re-gathers its authorization inside the same tab's lifecycle.
		const relaunched = recordingLauncher({ state: "running", host: runningHandle("S-DELETE-RACE") });
		const restore = index.restore(entry.tabId, { reconciler: releasedClaim, launcher: relaunched.launcher });
		const deletion = deleteManagedSession(
			{ tabId: entry.tabId, sessionFile: file },
			{
				index,
				reconciler: releasedClaim,
				windowHostRunning: () => index.get(entry.tabId)?.availability === "live",
			},
		);

		assert.equal((await restore).status, "restored");
		const deleted = await deletion;
		assert.equal(deleted.deleted, false, "a transcript a host now runs is not unlinked from under it");
		assert.equal(deleted.kind, "live-in-window");
		assert.equal(await pathExists(file), true);
		assert.ok(index.get(entry.tabId), "the row stays");
		assert.ok((await readClaim(claimDir, file)) !== null, "and the claim the host runs under stays held");
		assert.equal(relaunched.requests.length, 1, "one host was started for the transcript");
	});
});

// ── Working directories ─────────────────────────────────────────────────────

describe("working directories", () => {
	const windows = process.platform === "win32";

	/** A drive or POSIX root: the kind of value an earlier version's normalizer reduced to a drive-relative one. */
	const root = windows ? "C:\\" : "/";

	it("keeps a drive or POSIX root instead of stripping it away", () => {
		if (windows) {
			assert.equal(normalizeWorkspaceDirectory("C:\\"), "c:\\");
			assert.equal(normalizeWorkspaceDirectory("C:/"), "c:\\");
			assert.equal(normalizeWorkspaceDirectory("C:\\Projects\\"), "c:\\projects");
			assert.equal(isAbsoluteWorkspaceDirectory("C:\\"), true);
			assert.equal(isAbsoluteWorkspaceDirectory("\\\\server\\share"), true, "a UNC share is an absolute directory");
		} else {
			assert.equal(normalizeWorkspaceDirectory("/"), "/");
			assert.equal(normalizeWorkspaceDirectory("/Projects/"), "/Projects");
			assert.equal(isAbsoluteWorkspaceDirectory("/"), true);
		}
		assert.equal(
			isAbsoluteWorkspaceDirectory("\\foo"),
			false,
			"a drive-less rooted path is drive-relative, so it is not an absolute directory",
		);
	});

	it("keeps a value that is not absolute instead of resolving it against this process", () => {
		const host = normalizeWorkspaceDirectory(process.cwd());
		for (const value of ["", "   ", "C:", "relative", "relative/dir", "\\foo"]) {
			assert.notEqual(
				normalizeWorkspaceDirectory(value),
				host,
				`${JSON.stringify(value)} must never become this process's own folder`,
			);
			assert.equal(isAbsoluteWorkspaceDirectory(value), false, `${JSON.stringify(value)} is not an absolute directory`);
		}
		assert.equal(normalizeWorkspaceDirectory(""), "");
		assert.equal(normalizeWorkspaceDirectory("C:"), windows ? "c:" : "C:");
		assert.equal(normalizeWorkspaceDirectory("\\foo"), "\\foo");
	});

	it("reserves a draft in a drive or POSIX root and keeps it a usable absolute directory", async () => {
		const { claimDir } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);

		const draft = await index.createDraft({ cwd: root });

		assert.equal(draft.cwd, normalizeWorkspaceDirectory(root));
		assert.equal(isAbsoluteWorkspaceDirectory(draft.cwd), true, "a root folder must survive as an absolute cwd");
		assert.equal(indexFor(store, claimDir).get(draft.tabId)?.cwd, normalizeWorkspaceDirectory(root), "and survive a restart");
	});

	it("refuses a folder that is not absolute instead of resolving it", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-HEADER-CWD", cwd);
		// The same session, but with a header that records no cwd at all: the
		// caller's folder is then the only evidence there is.
		const bare = path.join(sessionDir, "2026-09-24T10-00-00_S-NO-CWD.jsonl");
		await writeFile(bare, `${JSON.stringify({ type: "session", version: 3, id: "S-NO-CWD" })}\n`, "utf8");

		for (const value of ["", "   ", "C:", "relative/dir", "\\foo"]) {
			await assert.rejects(
				() => index.createDraft({ cwd: value }),
				(error: unknown) => error instanceof SessionIndexError && error.code === "invalid-input",
				`createDraft must refuse ${JSON.stringify(value)}`,
			);
		}
		await assert.rejects(
			() => index.trackSession({ sessionFile: bare, cwd: "C:" }),
			(error: unknown) => error instanceof SessionIndexError && error.code === "invalid-input",
			"an import whose file records no cwd must refuse a folder that is not absolute",
		);
		assert.equal(index.list().length, 0, "a refused input never leaves a row behind");

		// The header's own directory is evidence, so this import is registered under
		// the directory the file records rather than the caller's unusable folder.
		const imported = await index.trackSession({ sessionFile: file, cwd: "C:" });
		assert.equal(imported.cwd, normalizeWorkspaceDirectory(cwd));
	});

	it("refuses a fileless draft whose cwd is not absolute, since no file could repair it", async () => {
		const { claimDir } = await tempWorkspace();
		const store = new TestStore();
		store.value = {
			version: 1,
			activeTabId: "tab:ambiguous-draft",
			nextOrdinal: 2,
			entries: [
				{
					tabId: "tab:ambiguous-draft",
					sessionFile: null,
					sessionId: null,
					cwd: windows ? "C:" : "",
					scope: { profile: null, sessionDir: null },
					sessionDir: null,
					ownership: { ownerGeneration: "generation-ambiguous", draftIdentity: "draft:ambiguous", releasedAt: null },
					host: null,
					createdAt: "2026-09-24T10:00:00.000Z",
					lastActiveAt: "2026-09-24T10:05:00.000Z",
					ordinal: 1,
					availability: "draft",
					detail: "Reserved draft identity; no session file has been written yet.",
				},
			],
		};

		const index = indexFor(store, claimDir);
		const { launcher, requests } = recordingLauncher({ state: "running", host: runningHandle("S-DRAFT") });
		const report = await index.restoreAll({ reconciler: noRecordedHost, launcher, restoreDrafts: true });

		assert.equal(requests.length, 0, "a folder is never guessed, so the draft starts no host");
		assert.deepEqual(report.failures.map(failure => failure.kind), ["ambiguous-cwd"]);
		assert.equal(index.get("tab:ambiguous-draft")?.availability, "failed");
		assert.match(report.failures[0]?.detail ?? "", /records no working directory/);
	});
});

// ── Run intent and editor slots ─────────────────────────────────────────────

describe("run intent and conversation state", () => {
	it("records the intent durably, separately from the observed availability", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-INTENT", cwd);
		const draft = await index.createDraft({ cwd });
		assert.equal(index.get(draft.tabId)?.runIntent, "stopped", "a fresh draft has not been asked to run");

		assert.equal((await index.promoteDraft(draft.tabId, file)).status, "promoted");
		await index.setRunIntent(draft.tabId, "running", "The user asked for this session to run.");
		// A restart sees the intent, not just the last availability.
		const restarted = indexFor(store, claimDir);
		assert.equal(restarted.get(draft.tabId)?.runIntent, "running");
		assert.equal(restarted.get(draft.tabId)?.detail, "The user asked for this session to run.");

		// An explicit close is the durable stop, and it survives another restart.
		const closed = await index.closeSession(draft.tabId, { confirmedStopped: true });
		assert.equal(closed.released, true);
		assert.equal(index.get(draft.tabId)?.runIntent, "stopped");
		assert.equal(indexFor(store, claimDir).get(draft.tabId)?.runIntent, "stopped");
	});


	it("records the session id a freshly launched new session reports, before any file exists, and never overwrites another id", async () => {
		const { claimDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const draft = await index.createDraft({ cwd });
		const { launcher } = recordingLauncher({ state: "running", host: { ...runningHandle(), sessionId: null } });
		const outcome = await index.restore(draft.tabId, { reconciler: noRecordedHost, launcher });
		assert.equal(outcome.status, "restored");
		assert.equal(index.get(draft.tabId)?.host?.sessionId, null, "a new session's id is only learned from get_state");

		assert.equal(await index.recordHostSessionId(draft.tabId, "S-NEW"), true);
		assert.equal(index.get(draft.tabId)?.sessionId, "S-NEW");
		assert.equal(index.get(draft.tabId)?.host?.sessionId, "S-NEW");
		assert.equal(indexFor(store, claimDir).get(draft.tabId)?.host?.sessionId, "S-NEW", "it survives a restart");

		assert.equal(await index.recordHostSessionId(draft.tabId, "S-NEW"), true, "recording the same id again is a no-op");
		assert.equal(await index.recordHostSessionId(draft.tabId, "S-OTHER"), false, "another id is a different session");
		assert.equal(index.get(draft.tabId)?.host?.sessionId, "S-NEW");
	});

	it("accepts the new conversation identity and binds its file after relaunching a draft with an old id", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const prior = indexFor(store, claimDir);
		const draft = await prior.createDraft({ cwd });
		await prior.recordHostSessionId(draft.tabId, "OLD-DRAFT");
		const index = indexFor(store, claimDir);
		const { launcher } = recordingLauncher({ state: "running", host: { ...runningHandle(), sessionId: null } });
		assert.equal((await index.restore(draft.tabId, { reconciler: freeWithoutEvidence, launcher })).status, "restored");
		assert.equal(await index.recordHostSessionId(draft.tabId, "NEW-DRAFT"), true);
		const file = await makeSessionFile(sessionDir, "NEW-DRAFT", cwd);
		assert.equal((await index.promoteDraft(draft.tabId, file)).status, "promoted");
		assert.equal(index.get(draft.tabId)?.sessionFile, file);
		assert.equal(indexFor(store, claimDir).get(draft.tabId)?.sessionId, "NEW-DRAFT");
		assert.equal(await index.recordHostSessionId(draft.tabId, "OTHER"), false, "current-runtime identity fencing still applies");
		await index.closeSession(draft.tabId, { confirmedStopped: true });
	});

	it("stores conversation-scoped activity identities, not a boolean", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const file = await makeSessionFile(sessionDir, "S-ACTIVITY", cwd);
		const entry = await managedSession(index, file, cwd);

		const updated = await index.recordConversationState(entry.tabId, {
			title: "Renamed in OMP",
			lastCompletedReplyId: "reply-2",
		});
		assert.equal(updated.title, "Renamed in OMP");
		assert.equal(updated.lastCompletedReplyId, "reply-2");
		assert.equal(updated.lastSeenReplyId, null, "a completion alone does not mark anything seen");

		const seen = await index.recordConversationState(entry.tabId, { lastSeenReplyId: "reply-2" });
		assert.equal(seen.lastSeenReplyId, "reply-2");
		// The read marker is part of the shared catalog row: another window, or this window after it
		// opened another folder (its own local record is then empty), sees the same verdict.
		const other = indexFor(store, claimDir);
		assert.equal(other.get(entry.tabId)?.lastCompletedReplyId, "reply-2");
		assert.equal(other.get(entry.tabId)?.lastSeenReplyId, "reply-2");
		await assert.rejects(() => index.recordConversationState("tab:missing", { title: "x" }), /No indexed tab/);
	});

	it("keeps a persisted title-less row on its ordinal label", async () => {
		const { claimDir } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const entry = await index.createDraft({ cwd: path.join(claimDir, "project") });
		assert.equal(entry.title, null);
		assert.equal(entry.runIntent, "stopped");
	});
});

describe("editor slots", () => {
	/** A conversation this window really runs: launched through the recorded host. */
	async function runningConversation(
		index: SessionIndex,
		sessionDir: string,
		cwd: string,
		sessionId: string,
	): Promise<SessionIndexEntry> {
		const file = await makeSessionFile(sessionDir, sessionId, cwd);
		const draft = await index.createDraft({ cwd });
		assert.equal((await index.promoteDraft(draft.tabId, file)).status, "promoted");
		const { launcher } = recordingLauncher({ state: "running", host: runningHandle(sessionId) });
		const outcome = await index.restore(draft.tabId, { reconciler: noRecordedHost, launcher });
		assert.equal(outcome.status, "restored", JSON.stringify(outcome));
		const entry = index.get(draft.tabId);
		assert.ok(entry);
		assert.equal(entry.runIntent, "running");
		return entry;
	}

	it("binds one slot per conversation and demotes a rival controller to passive", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const entry = await runningConversation(index, sessionDir, cwd, "S-SLOT");

		const first = await index.bindEditorSlot("slot:1", entry.tabId, "controlling");
		assert.equal(first.generation, 1);
		assert.equal(first.role, "controlling");
		// A second editor of the same conversation is a passive reader: it keeps an
		// unsent draft but issues no native operation.
		const second = await index.bindEditorSlot("slot:2", entry.tabId, "controlling");
		assert.equal(second.generation, 1);
		assert.equal(index.slotBinding("slot:1")?.role, "passive");
		assert.equal(index.slotBinding("slot:2")?.role, "controlling");
		assert.deepEqual(
			index.slotsForConversation(entry.tabId).map(binding => [binding.slotId, binding.role]),
			[
				["slot:1", "passive"],
				["slot:2", "controlling"],
			],
		);
		// An explicit passive marking never demotes a controlling binding.
		await index.bindEditorSlot("slot:3", entry.tabId, "passive");
		assert.equal(index.slotBinding("slot:2")?.role, "controlling");
		assert.equal(await index.unbindEditorSlot("slot:3"), true);
		assert.equal(index.slotBinding("slot:3"), null);
		await assert.rejects(() => index.bindEditorSlot("slot:4", "tab:missing", "controlling"), /No indexed tab/);
	});


	it("publishes no controlling role when the election cannot be recorded durably", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new FlakyStore();
		const index = indexFor(store, claimDir);
		const held = await runningConversation(index, sessionDir, cwd, "S-ELECT-DURABLE");

		store.failWrites = true;
		const refused = await index.bindEditorSlot("slot:x", held.tabId, "controlling");
		assert.equal(refused.role, "passive", `a role that was not recorded is not published (persistError: ${index.persistError})`);
		assert.match(refused.roleRefusal ?? "", /could not be recorded durably/);
		assert.equal(index.slotBinding("slot:x"), null, "nothing was left in memory either");

		store.failWrites = false;
		const recorded = await index.bindEditorSlot("slot:x", held.tabId, "controlling");
		assert.equal(recorded.role, "controlling", "the election succeeds once it can be recorded");
		assert.equal(index.slotBinding("slot:x")?.role, "controlling");
	});

	it("bumps the demoted controller's generation so stale controls stay fenced", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const entry = await runningConversation(index, sessionDir, cwd, "S-FENCE");

		await index.bindEditorSlot("slot:old", entry.tabId, "controlling");
		assert.equal(index.slotBinding("slot:old")?.generation, 1);
		await index.bindEditorSlot("slot:new", entry.tabId, "controlling");

		const demoted = index.slotBinding("slot:old");
		assert.equal(demoted?.role, "passive");
		// The role change is a binding change: a credential that still names
		// generation 1 must not be honoured by the demoted slot.
		assert.equal(demoted?.generation, 2);
		assert.equal(index.slotBinding("slot:new")?.generation, 1);
	});

	it("reads a binding witness and held transfers an earlier build wrote, and drops them on the next write", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, claimDir);
		const entry = await runningConversation(index, sessionDir, cwd, "S-PARSE-ONLY");
		await index.bindEditorSlot("slot:old", entry.tabId, "controlling");
		const snapshot = store.value as { bindings: Record<string, unknown>[] } & Record<string, unknown>;
		// The shape an earlier build persisted: a witness on the binding and a held transfer.
		store.value = {
			...snapshot,
			bindings: snapshot.bindings.map(binding => ({
				...binding,
				witness: { pid: 4242, instanceId: "host-1", roomGeneration: 2, previousRoomGeneration: 1, sessionFile: "x", sessionId: null, cwd: "x", observedAt: "2026-09-26T12:00:00.000Z" },
			})),
			heldTransfers: [{ attemptId: "transfer:old", slotId: "slot:old", fromTabId: entry.tabId }],
		};

		const restarted = indexFor(store, claimDir);
		assert.equal(restarted.loadError, null, "an obsolete field never discards the snapshot");
		assert.equal(restarted.slotBinding("slot:old")?.tabId, entry.tabId, "the binding itself is kept");
		assert.equal(restarted.slotBinding("slot:old")?.role, "controlling");
		assert.equal("witness" in (restarted.slotBinding("slot:old") ?? {}), false);

		await restarted.bindEditorSlot("slot:other", entry.tabId, "passive");
		const written = store.value as { bindings: Record<string, unknown>[] } & Record<string, unknown>;
		assert.equal("heldTransfers" in written, false, "held transfers are dropped on write");
		assert.equal(written.bindings.length, 2);
		assert.equal(written.bindings.some(binding => "witness" in binding), false, "and so is a binding witness");
	});
});

describe("partial native deletion and recovery", () => {
	it("reports a partial deletion with its leftover category and keeps the durable transaction", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-PARTIAL", cwd);
		const entry = await managedSession(index, file, cwd);
		// A leftover that cannot be unlinked (a directory where a backup file belongs).
		// OMP's own delete treats such a leftover as best-effort, and so does this one,
		// but it must report it.
		const stuck = `${file}.9999999.bak`;
		await mkdir(stuck);

		const options = deletionOptions(index, noRecordedHost);
		const result = await deleteManagedSession({ tabId: entry.tabId, sessionFile: file }, options);

		assert.equal(result.deleted, true, result.detail);
		assert.equal(result.partial, true, "a transcript gone with leftovers left is partial, not complete");
		assert.deepEqual(result.leftovers, ["rewrite-backup"]);
		assert.match(result.detail, /partial deletion/);
		assert.equal(await pathExists(file), false);
		assert.equal(await pathExists(stuck), true, "the undeletable leftover is still there");
		assert.equal(result.rowRemoved, true, "the row is finalized under the deletion's own held claim");
		assert.equal(await readClaim(claimDir, file), null, "the claim is released only after finalization");

		const transactions = await listNativeDeletionTransactions(options);
		assert.equal(transactions.length, 1);
		assert.equal(transactions[0]?.status, "partial");
		assert.equal(transactions[0]?.transcript.removed, true);
		assert.equal(transactions[0]?.owner.holderId, index.claimHolder.id);
		assert.equal(transactions[0]?.finalization, "row-dropped");
		assert.ok(
			transactions[0]?.backups.some(backup => backup.path === stuck && backup.removed === false),
			"the transaction names the exact leftover that survived",
		);

		// The recovery finishes the verified leftovers of exactly this transaction.
		const recovery = await recoverNativeDeletion(transactions[0]!.transactionId, options);
		assert.equal(recovery.partial, true);
		assert.deepEqual(recovery.leftovers, ["rewrite-backup"]);
		assert.match(recovery.detail, /still partial/);
		const afterRecovery = await listNativeDeletionTransactions(options);
		assert.equal(afterRecovery[0]?.status, "partial", "an unfinished recovery is never reported as complete");
	});

	it("finishes a recorded partial deletion once its leftovers are removable", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-RECOVER", cwd);
		const artifactsDir = file.slice(0, -".jsonl".length);
		const backup = `${file}.1234567.bak`;
		const store = createNativeDeletionEvidenceStore(path.join(claimDir, "native-deletions"));
		await store.write({
			transactionId: "native-delete:fixture",
			sessionFile: file,
			sessionId: "S-RECOVER",
			profile: null,
			artifactsDirectory: artifactsDir,
			frozenAt: "2026-09-26T10:00:00.000Z",
			updatedAt: "2026-09-26T10:00:00.000Z",
			owner: { ownerGeneration: "gen", holderId: index.claimHolder.id, claimPath: "claim" },
			transcript: { path: file, removed: true, detail: null },
			artifacts: { path: artifactsDir, removed: false, detail: "could not be removed" },
			backups: [{ path: backup, removed: false, detail: "could not be removed" }],
			finalization: "row-dropped",
			status: "partial",
			detail: "partial",
		});
		// The transcript is gone and both leftovers exist, exactly as the record says.
		await rm(file);
		await mkdir(artifactsDir, { recursive: true });
		await writeFile(path.join(artifactsDir, "child.jsonl"), "child", "utf8");
		await writeFile(backup, "stale", "utf8");

		const options = deletionOptions(index, noRecordedHost);
		const result = await recoverNativeDeletion("native-delete:fixture", options);
		assert.equal(result.deleted, true, result.detail);
		assert.equal(result.partial, false, result.detail);
		assert.equal(await pathExists(artifactsDir), false);
		assert.equal(await pathExists(backup), false);
		assert.equal(await readClaim(claimDir, file), null, "the recovery released its own claim");

		const recorded = await listNativeDeletionTransactions(options);
		assert.equal(recorded[0]?.status, "deleted");

		// A transaction whose transcript still exists is a normal deletion, not a
		// recovery: it must go through its own confirmation.
		const resurrected = await makeSessionFile(sessionDir, "S-RECOVER-2", cwd);
		await store.write({
			transactionId: "native-delete:with-transcript",
			sessionFile: resurrected,
			sessionId: "S-RECOVER-2",
			profile: null,
			artifactsDirectory: null,
			frozenAt: "2026-09-26T10:00:00.000Z",
			updatedAt: "2026-09-26T10:00:00.000Z",
			owner: { ownerGeneration: "gen", holderId: index.claimHolder.id, claimPath: "claim" },
			transcript: { path: resurrected, removed: false, detail: null },
			artifacts: null,
			backups: [],
			finalization: "none",
			status: "failed",
			detail: "failed",
		});
		const refused = await recoverNativeDeletion("native-delete:with-transcript", options);
		assert.equal(refused.deleted, false);
		assert.equal(refused.kind, "changed", refused.detail);
		assert.equal(await pathExists(resurrected), true);
	});

	it("refuses a frozen target that changed while the confirmation was open", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-FROZEN", cwd);
		const entry = await managedSession(index, file, cwd);
		const options = deletionOptions(index, noRecordedHost);
		const inspection = await inspectSessionDeletion(entry.tabId, options);
		assert.equal(inspection?.allowed, true);
		assert.equal(inspection?.sessionId, "S-FROZEN");

		// The file is replaced with another session's transcript before the removal.
		await writeFile(file, `${JSON.stringify({ type: "session", id: "S-OTHER-SESSION", cwd })}\n`, "utf8");
		const result = await deleteManagedSession(
			{ tabId: entry.tabId, sessionFile: file, sessionId: inspection?.sessionId ?? null, profile: inspection?.profile ?? null },
			options,
		);
		assert.equal(result.deleted, false);
		assert.equal(result.kind, "changed", result.detail);
		assert.equal(await pathExists(file), true, "a file that is no longer the confirmed session is kept");
		assert.ok(index.get(entry.tabId));
	});

	it("refuses to finalize a row with a claim that is not the deletion's own", async () => {
		const { claimDir, sessionDir, cwd } = await tempWorkspace();
		const index = indexFor(new TestStore(), claimDir);
		const file = await makeSessionFile(sessionDir, "S-ROW-CLAIM", cwd);
		const entry = await managedSession(index, file, cwd);
		const rivalHolder = createClaimHolder();
		const rival = await acquireClaim(claimDir, file, entry.ownership?.ownerGeneration ?? createOwnerGeneration(), rivalHolder);
		await rm(file);
		try {
			const dropped = await index.dropDeletedSession(entry.tabId, { sessionFile: file, heldClaim: rival });
			assert.equal(dropped.removed, false, dropped.detail);
			assert.ok(index.get(entry.tabId), "the row survives a claim it cannot verify");
		} finally {
			await rival.release();
		}
	});
});

// ── Fixtures for rows with a recorded launch attempt ────────────────────────
//
// A launch attempt is recorded before the launcher runs, so a row can hold a
// process identity, or none at all, that nothing can prove gone.

/** A row whose launch attempt is recorded, with the index and files around it. */
interface UnidentifiedFixture {
	readonly claimDir: string;
	readonly file: string;
	readonly tabId: string;
	readonly store: TestStore;
	readonly index: SessionIndex;
}

// ── A row with an identified, unresolved launch attempt ─────────────────────
//
// The broker that hosted the OMP session went away while the session kept
// running, so the row records a process and its broker identity that the
// automatic rule can no longer resolve.

/** A row that recorded a process *and* its broker identity, blocked as `owner-unknown`. */
async function identifiedAttempt(
	input: {
		readonly availability?: "live" | "saved";
		readonly ownerGeneration?: string;
	} = {},
): Promise<UnidentifiedFixture & { readonly host: RecordedHost }> {
	const { claimDir, sessionDir, cwd } = await tempWorkspace();
	const store = new TestStore();
	const file = await makeSessionFile(sessionDir, "S-MATCHED", cwd);
	const host: RecordedHost = {
		pid: 6200,
		instanceId: null,
		generation: null,
		sessionId: "S-MATCHED",
		startedAt: "2026-09-24T10:00:00.000Z",
		transport: "rpc",
		rpc: {
			slot: PROVEN_BROKER_SLOT,
			brokerId: "broker-id-of-record",
			brokerGeneration: "broker-generation-of-record",
			brokerPid: 6100,
			brokerCreationTime: "133700000000000000",
			childPid: 6200,
			childCreationTime: "133700000000000001",
		},
	};
	store.value = {
		version: 1,
		activeTabId: "tab:matched",
		nextOrdinal: 2,
		entries: [
			{
				tabId: "tab:matched",
				origin: "extension",
				sessionFile: file,
				sessionId: "S-MATCHED",
				cwd: normalizeWorkspaceDirectory(cwd),
				scope: { profile: null, sessionDir },
				sessionDir,
				ownership: { ownerGeneration: input.ownerGeneration ?? "generation-matched", draftIdentity: null, releasedAt: null },
				host,
				createdAt: "2026-09-24T10:00:00.000Z",
				lastActiveAt: "2026-09-24T10:05:00.000Z",
				ordinal: 1,
				availability: input.availability ?? "saved",
				detail: "the broker that hosted this launch is gone",
				runIntent: "running",
			},
		],
	};
	await acquireClaim(claimDir, file, "generation-matched", createClaimHolder(4194303));
	return { claimDir, file, tabId: "tab:matched", store, index: indexFor(store, claimDir), host };
}


// ── Stop of a recorded broker-owned host, with no runtime here ──────────────
//
// The state a reload leaves behind: the row records a launch this extension made,
// this window runs no native host for it, and the broker it started may still own
// the child. The index owns the ordering — claim first, stopped intent before the
// stop, the claim released only for a stop this window confirmed.

/** A stop port that records what it was asked and answers what the test decides. */
function recordingStopPort(
	result: RecordedHostStopResult,
	onCall?: () => void,
): { readonly port: RecordedHostStopPort; readonly calls: SessionIndexEntry[] } {
	const calls: SessionIndexEntry[] = [];
	return {
		calls,
		port: {
			async stopRecordedHost(entry) {
				calls.push(entry);
				onCall?.();
				return result;
			},
		},
	};
}

/** The attempt every case below confirms before it stops anything. */
const MATCHED_ATTEMPT = { attemptStartedAt: "2026-09-24T10:00:00.000Z", pid: 6200 };

describe("explicit stop of a recorded broker-owned host", () => {
	it("refuses to stop a process the confirmation did not name", async () => {
		const fixture = await identifiedAttempt();
		let called = false;
		const { port } = recordingStopPort(
			{ kind: "stopped", writerGone: true, treeEmpty: false, detail: "stopped", slot: "host:slot-1" },
			() => (called = true),
		);

		const stale = await fixture.index.stopRecordedHost(fixture.tabId, {
			stop: port,
			expect: { attemptStartedAt: "2026-09-24T09:00:00.000Z", pid: 6200 },
		});
		assert.equal(stale.stopped, false);
		assert.match(stale.detail, /different launch attempt than the one that was confirmed/);
		assert.equal(called, false, "a stale confirmation stops nothing");

		const otherProcess = await fixture.index.stopRecordedHost(fixture.tabId, {
			stop: port,
			expect: { attemptStartedAt: MATCHED_ATTEMPT.attemptStartedAt, pid: 6201 },
		});
		assert.equal(otherProcess.stopped, false);
		assert.match(otherProcess.detail, /different launch attempt/);
		assert.equal(called, false);
	});

	it("persists the stopped intent before the stop, releases the claim only on a confirmed stop, and clears the host", async () => {
		const fixture = await identifiedAttempt();
		let intentDuringStop: string | undefined;
		let guaranteeDuringStop: string | null = "unset";
		const { port, calls } = recordingStopPort(
			{
				kind: "stopped",
				writerGone: true,
				treeEmpty: false,
				detail: "The native OMP process (pid 6200) is gone and its claim can be released.",
				slot: "host:slot-1",
			},
			() => {
				intentDuringStop = fixture.index.get(fixture.tabId)?.runIntent;
				guaranteeDuringStop = fixture.index.get(fixture.tabId)?.ownership?.releasedAt ?? null;
			},
		);

		const result = await fixture.index.stopRecordedHost(fixture.tabId, { stop: port, expect: MATCHED_ATTEMPT });

		assert.equal(result.stopped, true, result.detail);
		assert.equal(result.slot, "host:slot-1");
		assert.equal(calls.length, 1, "one exact target is stopped");
		assert.equal(calls[0]?.host?.pid, 6200, "the port is given the recorded attempt, not a lookalike");
		assert.equal(
			intentDuringStop,
			"stopped",
			"the durable intent is written before anything is stopped, so an interrupted stop cannot become a launch",
		);
		assert.equal(guaranteeDuringStop, null, "the claim is released only after the stop is confirmed");
		const entry = fixture.index.get(fixture.tabId);
		assert.equal(entry?.host, null, "the recorded writer is cleared only for a confirmed stop");
		assert.equal(entry?.runIntent, "stopped");
		assert.equal(entry?.availability, "saved");
		assert.notEqual(entry?.ownership?.releasedAt, null);
		assert.equal(await readClaim(fixture.claimDir, fixture.file), null);
	});


	it("stops nothing when the row's process cannot be reached", async () => {
		const fixture = await identifiedAttempt();
		const { port } = recordingStopPort({
			kind: "unknown",
			detail: "no broker is recorded for this row's slot, so this window cannot reach the OMP process it started.",
		});

		const result = await fixture.index.stopRecordedHost(fixture.tabId, { stop: port, expect: MATCHED_ATTEMPT });

		assert.equal(result.stopped, false);
		assert.match(result.detail, /cannot reach the OMP process/);
		assert.equal(fixture.index.get(fixture.tabId)?.availability, "saved");
		assert.equal(fixture.index.get(fixture.tabId)?.detail, "no broker is recorded for this row's slot, so this window cannot reach the OMP process it started.");
		assert.equal(await readClaim(fixture.claimDir, fixture.file), null);
	});

	it("refuses a local runtime or missing attempt, but can stop a verified rival's broker without taking its claim", async () => {
		const running = await identifiedAttempt();
		const handle: OmpHostHandle = {
			pid: running.host.pid,
			sessionId: running.host.sessionId,
			rpc: running.host.rpc ?? null,
		};
		// A verified live writer: the row is re-adopted, never launched, and this window
		// then runs it.
		const reattaching: OmpHostLauncher = {
			async launch() {
				throw new Error("a live writer must never be launched");
			},
			async attach() {
				return { state: "attached", host: handle };
			},
		};
		const attached = await running.index.restore(running.tabId, {
			reconciler: attachableHost(handle),
			launcher: reattaching,
		});
		assert.ok(
			attached.status === "attached" || attached.status === "restored",
			JSON.stringify(attached),
		);
		let called = false;
		const { port } = recordingStopPort(
			{ kind: "stopped", writerGone: true, treeEmpty: false, detail: "stopped", slot: "host:slot-1" },
			() => (called = true),
		);
		const busy = await running.index.stopRecordedHost("tab:matched", { stop: port, expect: MATCHED_ATTEMPT });
		assert.equal(busy.stopped, false);
		assert.match(busy.detail, /running the native host for this tab/);
		assert.equal(called, false, "a host this window runs is Close Session's job");

		const unmatched = await identifiedAttempt();
		const store = unmatched.store;
		store.value = {
			...(store.value as { entries: unknown[] }),
			entries: [{ ...(store.value as { entries: Array<Record<string, unknown>> }).entries[0], host: null }],
		};
		const index = indexFor(store, unmatched.claimDir);
		const noHost = await index.stopRecordedHost(unmatched.tabId, { stop: port, expect: MATCHED_ATTEMPT });
		assert.equal(noHost.stopped, false);
		assert.match(noHost.detail, /recorded no launch attempt/);
		assert.equal(called, false);

		const rival = await identifiedAttempt({ ownerGeneration: "generation-elsewhere" });
		const held = await acquireClaim(rival.claimDir, rival.file, "rival-owner", createClaimHolder());
		const before = await readClaim(rival.claimDir, rival.file);
		const foreign = await rival.index.stopRecordedHost(rival.tabId, { stop: port, expect: MATCHED_ATTEMPT });
		assert.equal(foreign.stopped, true);
		assert.equal(called, true);
		assert.deepEqual(await readClaim(rival.claimDir, rival.file), before, "rival Stop never takes or releases the rival claim");
		await held.release();
	});
});

describe("same-editor managed transport replacement", () => {
	async function started(fileless = false) {
		const workspace = await tempWorkspace();
		const store = new TestStore();
		const index = indexFor(store, workspace.claimDir);
		const file = fileless ? null : await makeSessionFile(workspace.sessionDir, "mode-session", workspace.cwd);
		const entry = file === null ? await index.createDraft({ cwd: workspace.cwd }) : await index.trackSession({ sessionFile: file, cwd: workspace.cwd });
		const old = { ...runningHandle("mode-session"), transport: "rpc" as const };
		const launch = recordingLauncher({ state: "running", host: old });
		assert.equal((await index.restore(entry.tabId, { launcher: launch.launcher, reconciler: noRecordedHost, mode: "chat" })).status, "restored");
		await index.bindEditorSlot("mode-editor", entry.tabId, "controlling");
		return { ...workspace, index, store, file, entry: index.get(entry.tabId)!, old };
	}

	it("keeps the exact durable row and claim through the successor's persisted native launch", async () => {
		const f = await started();
		const before = await readClaim(f.claimDir, f.file!);
		const next = { ...f.old, pid: 5252, transport: "native" as const };
		const launch = recordingLauncher({ state: "running", host: next });
		launch.launcher.launch = async request => {
			assert.equal(request.transport, "native");
			assert.equal(request.sessionFile, f.file);
			assert.equal(request.sessionId, "mode-session");
			assert.deepEqual(await readClaim(f.claimDir, f.file!), before, "no unclaimed interval before native starts");
			const persisted = indexFor(f.store, f.claimDir);
			assert.equal(persisted.get(f.entry.tabId)?.host?.transport, "native");
			assert.equal(persisted.get(f.entry.tabId)?.host?.pid, null, "attempt is durable before launch");
			assert.equal(persisted.slotBinding("mode-editor")?.mode, "terminal");
			return { state: "running", host: next };
		};
		const result = await f.index.lifecycle.run(f.entry.tabId, lease => f.index.replaceHost(f.entry.tabId, {
			confirmedStopped: true, expectedPid: f.old.pid, expectedCreationTime: f.old.rpc!.childCreationTime!,
			mode: "terminal", slotId: "mode-editor", emptyFile: f.file, launcher: launch.launcher,
		}, lease));
		assert.equal(result.status, "restored");
		assert.equal(f.index.get(f.entry.tabId)?.ordinal, f.entry.ordinal);
		assert.equal(f.index.get(f.entry.tabId)?.sessionFile, f.file);
		assert.equal(f.index.get(f.entry.tabId)?.sessionId, "mode-session");
		assert.equal(f.index.slotBinding("mode-editor")?.tabId, f.entry.tabId);
		assert.deepEqual(await readClaim(f.claimDir, f.file!), before);
		await f.index.closeSession(f.entry.tabId, { confirmedStopped: true });
	});

	it("resets only a fileless draft's native identity while preserving its editor, row and claim", async () => {
		const f = await started(true);
		const identity = f.entry.ownership!.draftIdentity!;
		const before = await readClaim(f.claimDir, identity);
		const launch = recordingLauncher({ state: "running", host: { ...f.old, transport: "native", sessionId: "fresh-native" } });
		const result = await f.index.lifecycle.run(f.entry.tabId, lease => f.index.replaceHost(f.entry.tabId, {
			confirmedStopped: true, expectedPid: f.old.pid, expectedCreationTime: f.old.rpc!.childCreationTime!,
			mode: "terminal", slotId: "mode-editor", emptyFile: path.join(f.sessionDir, "allocated-but-not-written.jsonl"), launcher: launch.launcher,
		}, lease));
		assert.equal(result.status, "restored");
		assert.equal(launch.requests[0]?.sessionId, null);
		assert.equal(launch.requests[0]?.sessionFile, null);
		assert.equal(f.index.get(f.entry.tabId)?.sessionId, "fresh-native");
		assert.equal(f.index.get(f.entry.tabId)?.ordinal, f.entry.ordinal);
		assert.equal(f.index.slotBinding("mode-editor")?.tabId, f.entry.tabId);
		assert.deepEqual(await readClaim(f.claimDir, identity), before);
		await f.index.closeSession(f.entry.tabId, { confirmedStopped: true });
	});

	it("never launches on uncertain exit or a missing durable file, and releases only a failed settled successor", async () => {
		const f = await started();
		const launch = recordingLauncher({ state: "not-started", reason: "native executable unavailable" });
		const replace = (confirmedStopped: boolean) => f.index.lifecycle.run(f.entry.tabId, lease => f.index.replaceHost(f.entry.tabId, {
			confirmedStopped, expectedPid: f.old.pid, expectedCreationTime: f.old.rpc!.childCreationTime!,
			mode: "terminal", slotId: "mode-editor", emptyFile: f.file, launcher: launch.launcher,
		}, lease));
		assert.equal((await replace(false)).status, "failed");
		assert.equal(launch.requests.length, 0);
		assert.ok(await readClaim(f.claimDir, f.file!));
		const contents = await readFile(f.file!, "utf8");
		await rm(f.file!);
		assert.equal((await replace(true)).status, "failed");
		assert.equal(launch.requests.length, 0, "a durable row cannot be recast as an empty draft");
		await writeFile(f.file!, contents);
		assert.equal((await replace(true)).status, "failed");
		assert.equal(f.index.get(f.entry.tabId)?.runIntent, "stopped");
		assert.equal(await readClaim(f.claimDir, f.file!), null, "failed successor releases only after exact stop proof");
	});

	it("restores a saved native editor mode without losing it to unrelated binding changes", async () => {
		const f = await started();
		await f.index.setEditorMode("mode-editor", "terminal");
		assert.equal(indexFor(f.store, f.claimDir).slotBinding("mode-editor")?.mode, "terminal");
		await f.index.bindEditorSlot("other-editor", f.entry.tabId, "controlling");
		assert.equal(f.index.slotBinding("mode-editor")?.mode, "terminal");
		await f.index.closeSession(f.entry.tabId, { confirmedStopped: true });
	});
});

describe("atomic best-effort native conversation binding", () => {
	async function nativePair() {
		const workspace = await tempWorkspace();
		const store = createCatalogStore({ paths: catalogPaths(workspace.cwd), mergers: {
			[SESSION_INDEX_STORAGE_KEY]: mergeSessionIndexRecords, [BROKER_SLOTS_KEY]: mergeBrokerSlotRecords,
		} });
		const index = indexFor(store, workspace.claimDir);
		const fileA = await makeSessionFile(workspace.sessionDir, "native-A", workspace.cwd);
		const fileB = await makeSessionFile(workspace.sessionDir, "native-B", workspace.cwd);
		const a = await index.trackSession({ sessionFile: fileA, cwd: workspace.cwd });
		const b = await index.trackSession({ sessionFile: fileB, cwd: workspace.cwd });
		const slot = createHostSlotId(); const stoppedSlot = createHostSlotId();
		const host = { ...runningHandle("native-A"), transport: "native" as const, rpc: { ...runningHandle().rpc!, slot } };
		assert.equal((await index.restore(a.tabId, { launcher: recordingLauncher({ state: "running", host }).launcher, reconciler: noRecordedHost, mode: "terminal" })).status, "restored");
		await index.bindEditorSlot("native-editor", a.tabId, "controlling");
		const mapping = createBrokerSlotStore(store);
		await mapping.record({ slot, conversation: a.tabId, editor: "native-editor" });
		await mapping.record({ slot: stoppedSlot, conversation: b.tabId, editor: "stopped-editor" });
		const transfer = (reconciler = noRecordedHost) => index.transferNativeHost({
			fromTabId: a.tabId, toTabId: b.tabId, slotId: "native-editor",
			expectedPid: host.pid, expectedCreationTime: host.rpc.childCreationTime!, sessionId: "native-B", name: "B title", reconciler,
			brokerMapping: { key: BROKER_SLOTS_KEY, decide: latest => {
				const plan = mapping.planRepointAgainst(latest, a.tabId, b.tabId, stoppedSlot);
				return plan.ok ? { desired: plan.value } : { refused: plan.reason };
			} },
		});
		return { ...workspace, store, index, a, b, host, slot, stoppedSlot, mapping, transfer };
	}

	it("publishes both rows and broker mapping together, claims B before releasing A and preserves E/root", async () => {
		const f = await nativePair();
		const before = f.store.revision();
		const generation = f.index.slotBinding("native-editor")!.generation;
		assert.equal((await f.transfer()).status, "bound");
		assert.equal(f.store.revision(), before + 1, "rows and mapping share one durable catalog commit");
		const reopened = indexFor(f.store, f.claimDir);
		const mapping = createBrokerSlotStore(f.store);
		assert.equal(reopened.get(f.a.tabId)?.host, null);
		assert.equal(reopened.get(f.a.tabId)?.runIntent, "stopped");
		assert.equal(reopened.get(f.b.tabId)?.host?.pid, f.host.pid);
		assert.equal(reopened.get(f.b.tabId)?.title, "B title");
		assert.equal(reopened.slotBinding("native-editor")?.tabId, f.b.tabId);
		assert.equal(reopened.slotBinding("native-editor")?.generation, generation + 1);
		assert.equal(mapping.forConversation(f.a.tabId), null);
		assert.equal(mapping.forConversation(f.b.tabId), f.slot);
		assert.equal(mapping.forEditor("stopped-editor"), f.stoppedSlot, "retired editor retains its recovery provenance");
		assert.equal(await readClaim(f.claimDir, f.a.sessionFile!), null);
		assert.ok(await readClaim(f.claimDir, f.b.sessionFile!));
		await f.index.closeSession(f.b.tabId, { confirmedStopped: true });
	});

	it("does not steal a verified rival or publish a newer destination mapping over its writer", async () => {
		const f = await nativePair();
		const before = f.index.slotBinding("native-editor");
		const rival = await acquireClaim(f.claimDir, f.b.sessionFile!, "rival-native", createClaimHolder());
		assert.deepEqual(await f.transfer(liveHost), { status: "refused", kind: "conflict", detail: "A verified rival owns the observed native destination; the newcomer cannot control it." });
		assert.deepEqual(f.index.slotBinding("native-editor"), before);
		await rival.release();
		const newer = createHostSlotId();
		await f.mapping.record({ slot: newer, conversation: f.b.tabId, editor: "newer-editor" });
		const refused = await f.transfer();
		assert.equal(refused.status, "refused");
		assert.equal(f.index.get(f.a.tabId)?.host?.pid, f.host.pid);
		assert.equal(f.index.get(f.b.tabId)?.host, null);
		assert.deepEqual(f.index.slotBinding("native-editor"), before, "failed atomic handover restores the old binding");
		assert.ok(await readClaim(f.claimDir, f.a.sessionFile!));
		assert.equal(await readClaim(f.claimDir, f.b.sessionFile!), null, "rollback releases only B's newly acquired claim");
		assert.equal(createBrokerSlotStore(f.store).forConversation(f.b.tabId), newer);
		await f.index.closeSession(f.a.tabId, { confirmedStopped: true });
	});
});
