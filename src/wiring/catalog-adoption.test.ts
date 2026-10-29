/**
 * The catalog adoption and the startup restore of a window: what a change of the catalog makes this window do, by record key,
 * and the state of the restore pass. The catalog stores and the session indexes are real (two windows over one catalog
 * directory); the window's own stores, the launcher and the restore pass are counted fakes.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BROKER_SLOTS_KEY, mergeBrokerSlotRecords } from "../host/broker-slots.ts";
import { catalogPaths, createCatalogStore } from "../host/profile-catalog.ts";
import type { CatalogRefresh, CatalogStore } from "../host/profile-catalog.ts";
import { SESSION_INDEX_STORAGE_KEY, SessionIndex, mergeSessionIndexRecords } from "../host/session-index.ts";
import type { SessionIndexRefresh } from "../host/session-index.ts";
import { SHELL_SLOTS_KEY, mergeShellSlotRecords } from "../host/shell-slots.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { WORKSPACE_FOLDERS_STORAGE_KEY, mergeWorkspaceFolderRecords } from "../views/workspace-folders.ts";
import { registerCatalogAdoption } from "./catalog-adoption.ts";
import type { AdoptionIndex, CatalogAdoption, CatalogAdoptionDeps } from "./catalog-adoption.ts";

const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const MERGERS = {
	[SESSION_INDEX_STORAGE_KEY]: mergeSessionIndexRecords,
	[BROKER_SLOTS_KEY]: mergeBrokerSlotRecords,
	[SHELL_SLOTS_KEY]: mergeShellSlotRecords,
	[WORKSPACE_FOLDERS_STORAGE_KEY]: mergeWorkspaceFolderRecords,
};

const yieldIo = (): Promise<void> => setImmediate();

/** A second window over one catalog directory, and a first one whose adoption is under test. */
async function world(rowCount: number) {
	const root = await mkdtemp(path.join(tmpdir(), "omp-adoption-"));
	roots.push(root);
	const paths = catalogPaths(root);
	const claims = path.join(root, "claims");
	const open = (): Promise<CatalogStore> => createCatalogStore({ paths, mergers: MERGERS });

	const peerStore = await open();
	const peer = new SessionIndex({ store: peerStore, claimStorageDir: claims });
	const tabs: string[] = [];
	for (let at = 0; at < rowCount; at++) tabs.push((await peer.createDraft({ cwd: root })).tabId);

	const store = await open();
	const real = new SessionIndex({ store, claimStorageDir: claims });
	const count = { reads: 0, brokerReloads: 0, shellReloads: 0, folderReloads: 0, repaints: 0, roles: 0, claimDrops: 0 };
	const sessionPasses: { options: { changedOnly?: boolean } | undefined; result: SessionIndexRefresh }[] = [];
	let failNextSessionPass = false;
	let lastRead: Promise<unknown> = Promise.resolve();
	const catalog: CatalogStore = {
		...store,
		refresh: () => {
			count.reads++;
			lastRead = store.refresh();
			return lastRead as Promise<CatalogRefresh | null>;
		},
	};
	const index: AdoptionIndex = {
		refreshFromStore: async options => {
			if (failNextSessionPass) {
				failNextSessionPass = false;
				throw new Error("the index is busy");
			}
			const result = await real.refreshFromStore(options);
			sessionPasses.push({ options, result });
			return result;
		},
		hasLiveHost: tabId => real.hasLiveHost(tabId),
		get: tabId => real.get(tabId),
		list: () => real.list(),
		sweepGoneRecords: options => real.sweepGoneRecords(options),
	};
	const lines: LoggedLine[] = [];
	let signal: (() => void) | null = null;
	const subscriptions: { dispose(): void }[] = [];
	const folders = { reload: async () => { count.folderReloads++; return true; } };
	const deps: CatalogAdoptionDeps = {
		log: recordingLogger(lines),
		activatedAt: Date.now(),
		catalog: () => catalog,
		brokerSlots: () => ({ reload: () => { count.brokerReloads++; } }),
		shellSlots: () => ({ reload: () => { count.shellReloads++; } }),
		dropClaimFileNames: () => { count.claimDrops++; },
		reconcileLocalRoles: () => { count.roles++; },
		refreshLauncher: () => { count.repaints++; },
		importPredecessorFolders: async () => undefined,
		catalogRead: () => undefined,
		watchCatalog: (_paths, onSignal) => { signal = onSignal; return () => { signal = null; }; },
		subscribe: disposable => { subscriptions.push(disposable); },
		startBackup: () => undefined,
		restoreTabs: async () => undefined,
		hasLocalEditorFor: () => false,
		owningWindow: () => null,
		startRuntimeProof: () => undefined,
		reconciler: () => ({ reconcile: async () => ({ kind: "free", evidence: [] }) }) as never,
		timing: () => undefined,
	};
	const adoption = registerCatalogAdoption(deps);
	adoption.activate(index, folders, catalog);
	await adoption.ready();
	await adoption.idle();

	const reset = (): void => {
		for (const key of Object.keys(count) as (keyof typeof count)[]) count[key] = 0;
		sessionPasses.length = 0;
		lines.length = 0;
	};
	reset();
	return {
		adoption, index, folders, peer, peerStore, tabs, count, sessionPasses, lines, subscriptions, real, root, reset,
		failNextSessionPass: () => { failNextSessionPass = true; },
		/** What the watcher does on a signal of the catalog's files: read the document, and let the notification drive the adoption. */
		async signal(): Promise<void> {
			assert.ok(signal !== null, "the watch is running");
			signal();
			await lastRead;
			await adoption.idle();
		},
	};
}

describe("adopting what a catalog commit changed", () => {
	it("takes a reply-marker-only foreign commit as one row: no store reloaded, no folder list read, no other row", async () => {
		const w = await world(8);
		await w.peer.recordConversationState(w.tabs[3]!, { lastCompletedReplyId: "event-m1" });
		await w.signal();

		assert.equal(w.count.reads, 1, "the document is read once");
		assert.deepEqual([w.count.brokerReloads, w.count.shellReloads, w.count.folderReloads], [0, 0, 0]);
		assert.equal(w.sessionPasses.length, 1);
		assert.deepEqual(w.sessionPasses[0]!.options, { changedOnly: true });
		assert.deepEqual(w.sessionPasses[0]!.result.touched, [w.tabs[3]], "only the row whose marker moved was read");
		assert.equal(w.real.get(w.tabs[3]!)?.lastCompletedReplyId, "event-m1");
		assert.equal(w.count.repaints, 1, "the unread mark is visible, so the launcher is repainted once");
		assert.deepEqual([w.count.roles, w.count.claimDrops], [0, 0], "the bindings and the row targets did not change");
		assert.deepEqual(w.lines, [], "nothing was adopted or dropped to report");
	});

	it("takes a change of one session row as that row, and a new or removed row with the claim names dropped", async () => {
		const w = await world(5);
		await w.peer.setRunIntent(w.tabs[1]!, "running");
		await w.signal();
		assert.deepEqual(w.sessionPasses.map(pass => pass.result.touched), [[w.tabs[1]]]);
		assert.equal(w.count.claimDrops, 0);

		w.reset();
		const added = (await w.peer.createDraft({ cwd: w.root })).tabId;
		await w.peer.remove(w.tabs[0]!);
		await w.signal();
		assert.deepEqual([...w.sessionPasses.at(-1)!.result.touched].sort(), [added, w.tabs[0]!].sort());
		assert.equal(w.count.claimDrops >= 1, true, "a row came and one went, so the claim file names are resolved again");
		assert.match(w.lines.map(line => line.message).join("\n"), /adopted 1 new row\(s\), dropped 1/);
	});

	it("reloads the folder list for the folder record only", async () => {
		const w = await world(3);
		await w.peerStore.transact([{ key: WORKSPACE_FOLDERS_STORAGE_KEY, apply: () => ({ version: 1, folders: [] }) }]);
		await w.signal();
		assert.deepEqual([w.count.folderReloads, w.count.brokerReloads, w.count.shellReloads], [1, 0, 0]);
		assert.equal(w.sessionPasses.length, 0, "no session row was read");
		assert.equal(w.count.repaints, 1);
	});

	it("reloads a slot store for its own record only", async () => {
		const w = await world(3);
		await w.peerStore.transact([{ key: BROKER_SLOTS_KEY, apply: () => ({ byEditor: {}, byConversation: {}, conflictedConversations: [], conflictedEditors: [] }) }]);
		await w.signal();
		assert.deepEqual([w.count.brokerReloads, w.count.shellReloads, w.count.folderReloads, w.sessionPasses.length], [1, 0, 0, 0]);

		w.reset();
		await w.peerStore.transact([{ key: SHELL_SLOTS_KEY, apply: () => ({ version: 1, slots: [] }) }]);
		await w.signal();
		assert.deepEqual([w.count.brokerReloads, w.count.shellReloads, w.count.folderReloads, w.sessionPasses.length], [0, 1, 0, 0]);
	});

	it("does nothing, and repaints nothing, when the files signalled but the catalog did not change", async () => {
		const w = await world(3);
		await w.signal();
		assert.equal(w.count.reads, 1);
		assert.deepEqual([w.count.repaints, w.count.brokerReloads, w.count.folderReloads, w.sessionPasses.length], [0, 0, 0, 0]);
	});

	it("adopts this window's own commit without reading the document again", async () => {
		const w = await world(4);
		await w.real.recordConversationState(w.tabs[2]!, { lastCompletedReplyId: "event-own" });
		await w.adoption.idle();
		assert.equal(w.count.reads, 0, "the commit already advanced the projection");
		assert.ok(w.sessionPasses.every(pass => pass.options?.changedOnly === true));
		assert.deepEqual([w.count.brokerReloads, w.count.shellReloads, w.count.folderReloads], [0, 0, 0]);
	});

	it("keeps a change it could not adopt for the next run, whatever asks for it", async () => {
		const w = await world(4);
		w.failNextSessionPass();
		await w.peer.recordConversationState(w.tabs[1]!, { lastSeenReplyId: "event-m1" });
		await w.signal();
		assert.equal(w.real.get(w.tabs[1]!)?.lastSeenReplyId, null, "the pass failed");
		assert.match(w.lines.map(line => line.message).join("\n"), /could not be adopted: the index is busy/);

		await w.peerStore.transact([{ key: WORKSPACE_FOLDERS_STORAGE_KEY, apply: () => ({ version: 1, folders: [] }) }]);
		await w.signal();
		assert.equal(w.real.get(w.tabs[1]!)?.lastSeenReplyId, "event-m1", "the next run took the row it had to leave");
		assert.equal(w.count.folderReloads, 1);
	});

	it("adopts everything on an explicit request: a missed notification costs a refresh, never correctness", async () => {
		const w = await world(6);
		await w.peer.recordConversationState(w.tabs[0]!, { lastCompletedReplyId: "event-m1" });
		// The watcher missed it: no signal, no notification.
		await w.adoption.adopt(w.index, w.folders);
		assert.equal(w.count.reads, 1);
		assert.deepEqual([w.count.brokerReloads, w.count.shellReloads, w.count.folderReloads], [1, 1, 1]);
		assert.deepEqual(w.sessionPasses.map(pass => pass.options), [{}], "every row is read");
		assert.equal(w.sessionPasses[0]!.result.touched.length, 6);
		assert.equal(w.real.get(w.tabs[0]!)?.lastCompletedReplyId, "event-m1");
		assert.ok(w.count.repaints >= 1);
		assert.equal(w.count.roles, 1);
	});

	it("runs one follow-up for the notifications that arrive while a run is in flight", async () => {
		const w = await world(3);
		await w.peer.recordConversationState(w.tabs[0]!, { lastCompletedReplyId: "event-a" });
		await w.peer.recordConversationState(w.tabs[1]!, { lastCompletedReplyId: "event-b" });
		await w.peer.recordConversationState(w.tabs[2]!, { lastCompletedReplyId: "event-c" });
		await w.signal();
		assert.equal(w.count.reads, 1);
		assert.deepEqual(w.sessionPasses.flatMap(pass => pass.result.touched).sort(), [...w.tabs].sort());
		assert.equal(w.sessionPasses.length, 1, "three commits one read saw are one pass");
	});

	it("releases its subscriptions and the watch", async () => {
		const w = await world(1);
		assert.equal(w.subscriptions.length, 2, "the notification listener and the file watch");
		for (const subscription of w.subscriptions) subscription.dispose();
		await w.peer.recordConversationState(w.tabs[0]!, { lastCompletedReplyId: "event-x" });
		await w.real.recordConversationState(w.tabs[0]!, { lastSeenReplyId: "event-x" });
		await yieldIo();
		assert.equal(w.sessionPasses.length, 0, "nothing is adopted once the window is disposed");
	});
});

describe("the startup restore", () => {
	function fakeIndex(rows: Record<string, { live?: boolean; editor?: boolean }>) {
		const swept: unknown[] = [];
		const index: AdoptionIndex = {
			refreshFromStore: async () => ({ adopted: [], removed: [], kept: [], touched: [], bindingsChanged: false }),
			hasLiveHost: tabId => rows[tabId]?.live === true,
			get: tabId => (tabId in rows ? ({ tabId, home: null, runIntent: "stopped" } as never) : null),
			list: () => Object.keys(rows).map(tabId => ({ tabId }) as never),
			sweepGoneRecords: async options => { swept.push(options); return { cleared: [], orphanClaims: 0 }; },
		};
		return { index, swept };
	}

	function restoring(rows: Record<string, { live?: boolean; editor?: boolean }>) {
		const { index } = fakeIndex(rows);
		const pass = Promise.withResolvers<void>();
		const seen: { cohort: ReadonlySet<string> | null; parking: boolean } = { cohort: null, parking: false };
		const count = { repaints: 0, proofs: 0, backups: 0 };
		const lines: LoggedLine[] = [];
		const catalog = { refresh: async () => null, onChange: () => () => undefined, paths: catalogPaths(tmpdir()) } as unknown as CatalogStore;
		let adoption!: CatalogAdoption;
		const deps: CatalogAdoptionDeps = {
			log: recordingLogger(lines),
			activatedAt: Date.now(),
			catalog: () => catalog,
			brokerSlots: () => undefined,
			shellSlots: () => undefined,
			dropClaimFileNames: () => undefined,
			reconcileLocalRoles: () => undefined,
			refreshLauncher: () => { count.repaints++; },
			importPredecessorFolders: async () => undefined,
			catalogRead: () => undefined,
			watchCatalog: () => () => undefined,
			subscribe: () => undefined,
			startBackup: () => { count.backups++; },
			restoreTabs: async (_index, cohort) => {
				seen.cohort = cohort;
				seen.parking = adoption.restoreParking() !== null;
				await pass.promise;
			},
			hasLocalEditorFor: tabId => rows[tabId]?.editor === true,
			owningWindow: () => null,
			startRuntimeProof: () => { count.proofs++; },
			reconciler: () => ({}) as never,
			timing: () => undefined,
		};
		adoption = registerCatalogAdoption(deps);
		return { adoption, index, pass, seen, count, lines, catalog, folders: { reload: async () => false } };
	}

	it("is pending until activation has adopted the catalog, then covers exactly the cohort while the pass runs", async () => {
		const w = restoring({ live: { live: true }, editor: { editor: true }, other: {} });
		assert.ok(w.adoption.startupRestoreOver() !== null, "a display-only read waits from the first moment");
		assert.equal(w.adoption.startupRestoreSettled(), false);
		assert.equal(w.adoption.restoreCovers("live"), false, "no pass yet");
		assert.equal(w.adoption.startupCovers(w.index, "live"), true, "a row the pass will take reads as restoring");
		assert.equal(w.adoption.startupCovers(w.index, "other"), false);
		assert.equal(w.adoption.startupCovers(null, "live"), false, "without an index nothing can be said");

		w.adoption.activate(w.index, w.folders, w.catalog);
		await w.adoption.ready();
		await yieldIo();

		assert.deepEqual([...w.seen.cohort ?? []].sort(), ["editor", "live"], "a live host and a restored editor, not a row only the index holds");
		assert.equal(w.seen.parking, true, "kept broker connections are available during the pass");
		assert.equal(w.adoption.restoreCovers("live"), true);
		assert.equal(w.adoption.restoreCovers("other"), false);
		assert.equal(w.adoption.startupCovers(w.index, "other"), false);
		assert.ok(w.adoption.startupRestore() !== null);
		assert.equal(w.adoption.startupRestoreSettled(), false);
		assert.ok(w.adoption.restoreParking() !== null);
		assert.equal(w.count.backups, 1, "the backup starts with the restore");

		w.pass.resolve();
		await w.adoption.startupOver;
		assert.equal(w.adoption.startupRestoreOver(), null);
		assert.equal(w.adoption.startupRestoreSettled(), true);
		assert.equal(w.adoption.startupRestore(), null);
		assert.equal(w.adoption.restoreParking(), null);
		assert.equal(w.count.proofs, 1, "the runtime proof starts when the attach work is done");
		assert.ok(w.count.repaints >= 3, "the launcher is repainted by the adoption, the start and the end of the pass");
	});

	it("settles when the pass fails, and says so", async () => {
		const w = restoring({ live: { live: true } });
		w.pass.reject(new Error("a launch threw"));
		w.adoption.activate(w.index, w.folders, w.catalog);
		await w.adoption.ready();
		await w.adoption.startupOver;
		assert.equal(w.adoption.startupRestoreOver(), null);
		assert.match(w.lines.map(line => line.message).join("\n"), /the startup pass failed: a launch threw/);
	});

	it("ends the deferral by its cap clock even if the pass never settles, and releases the clock", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const w = restoring({});
			let over = false;
			void w.adoption.startupOver.then(() => { over = true; });
			w.adoption.armDeferralCap();
			mock.timers.tick(119_000);
			await yieldIo();
			assert.equal(over, false);
			mock.timers.tick(1_000);
			await yieldIo();
			assert.equal(over, true, "a display-only read no longer waits");
			const second = restoring({});
			second.adoption.armDeferralCap().dispose();
			mock.timers.tick(200_000);
			await yieldIo();
			assert.ok(second.adoption.startupRestoreOver() !== null, "a disposed clock does not end the deferral");
		} finally {
			mock.timers.reset();
		}
	});
});
