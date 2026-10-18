/**
 * The passive editor-slot bindings of closed editors are dropped (ADR-0025 amendment of 2026-10-19), over real parts: two
 * windows with their own indexes on one profile catalog, their own registry records in one registry directory, and a local
 * store each. Only the clock and the editor membership are stand-ins.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { BROKER_SLOTS_KEY, mergeBrokerSlotRecords } from "./broker-slots.ts";
import { EDITOR_SLOT_SETTLE_MS, EDITOR_SLOT_WATCH_KEY, EditorSlotPruner, EditorSlotWatch } from "./editor-slot-prune.ts";
import type { SlotPruneReport } from "./editor-slot-prune.ts";
import { catalogPaths, createCatalogStore } from "./profile-catalog.ts";
import type { CatalogStore } from "./profile-catalog.ts";
import { SESSION_INDEX_STORAGE_KEY, SessionIndex, mergeSessionIndexRecords } from "./session-index.ts";
import { WindowRegistry } from "./window-registry.ts";

const roots: string[] = [];
const registries: WindowRegistry[] = [];
after(async () => {
	for (const registry of registries) registry.dispose();
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

const slot = (letter: string): string => letter.repeat(32);
const [A, B, C] = [slot("a"), slot("b"), slot("c")];

/** A `workspaceState` stand-in that outlives the extension host, as the real one does across a reload. */
class MemoryStore {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

/** One window of the profile. `membership` is its VS Code tab set. */
interface Window {
	readonly pid: number;
	readonly store: CatalogStore;
	readonly index: SessionIndex;
	readonly registry: WindowRegistry;
	readonly membership: Set<string>;
	readonly watch: EditorSlotWatch;
	readonly pruner: EditorSlotPruner;
	readonly local: MemoryStore;
	/** What a heartbeat does: publish the tab set (`slots: false` is a window of an earlier build that publishes none). */
	publish(options?: { readonly slots?: boolean }): Promise<void>;
	/** What the catalog watcher does: read the other windows' commits. */
	adopt(): Promise<void>;
	/** The slot ids the catalog commits now. */
	committed(): Promise<string[]>;
	/** This window opens an editor: its binding is committed, its tab is in the tab set and its record says so. */
	bind(slotId: string, tabId: string, role?: "passive" | "controlling"): Promise<void>;
}

interface World {
	readonly cwd: string;
	advance(ms: number): void;
	kill(window: Window): void;
	openWindow(name: string, local?: MemoryStore, options?: { readonly complete?: boolean }): Promise<Window>;
}

async function profile(): Promise<World> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-slot-prune-"));
	roots.push(root);
	const cwd = path.join(root, "project");
	const claimDir = path.join(root, "claims");
	await mkdir(cwd, { recursive: true });
	await mkdir(claimDir, { recursive: true });
	const registryDir = path.join(root, "global");
	let clock = Date.parse("2026-10-19T10:00:00.000Z");
	const dead = new Set<number>();
	let nextPid = 100;

	return {
		cwd,
		advance: ms => { clock += ms; },
		kill: window => { dead.add(window.pid); },
		async openWindow(name, local = new MemoryStore(), options = {}) {
			const store = await createCatalogStore({ paths: catalogPaths(cwd), mergers: {
				[SESSION_INDEX_STORAGE_KEY]: mergeSessionIndexRecords, [BROKER_SLOTS_KEY]: mergeBrokerSlotRecords,
			} });
			const index = new SessionIndex({ store, claimStorageDir: claimDir, now: () => new Date(clock) });
			const pid = nextPid++;
			const registry = new WindowRegistry({
				storageDir: registryDir, holderId: name, pid, now: () => clock, pidAlive: candidate => !dead.has(candidate), writeDebounceMs: 5, heartbeatMs: 1_000_000,
			});
			registries.push(registry);
			const membership = new Set<string>();
			const watch = new EditorSlotWatch({ store: local, now: () => clock });
			const pruner = new EditorSlotPruner({ watch, membership: () => membership, registry: () => registry, index: () => index });
			if (options.complete !== false) pruner.markComplete();
			const window: Window = {
				pid, store, index, registry, membership, watch, pruner, local,
				async publish(options = {}) {
					registry.setSnapshot({ windowUri: null, label: name, folders: [], liveCwds: [], rows: {}, focusedAt: null, stale: false, ...(options.slots === false ? {} : { slots: [...membership] }) });
					await registry.flush();
				},
				async adopt() {
					await store.refresh();
					await index.refreshFromStore();
				},
				async committed() {
					await store.refresh();
					return (store.get<{ bindings?: { slotId: string }[] }>(SESSION_INDEX_STORAGE_KEY)?.bindings ?? []).map(binding => binding.slotId).sort();
				},
				async bind(slotId, tabId, role = "passive") {
					await index.bindEditorSlot(slotId, tabId, role);
					membership.add(slotId);
					pruner.observe();
					await window.publish();
				},
			};
			return window;
		},
	};
}

/** The editor of `slotId` closes in `window` (the tab leaves its tab set). */
function close(window: Window, slotId: string): void {
	window.membership.delete(slotId);
	window.pruner.observe();
}

/** Every window publishes after a whole settle interval, and the pruner of `acting` decides: what the heartbeats of a profile do. */
async function settle(world: World, windows: readonly Window[], acting: Window): Promise<SlotPruneReport> {
	world.advance(EDITOR_SLOT_SETTLE_MS + 1_000);
	for (const window of windows) await window.publish();
	return acting.pruner.run();
}

describe("dropping the passive bindings of closed editors", () => {
	it("drops the binding of a closed editor from the catalog and the window once the absence has settled", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		assert.deepEqual(await w.committed(), [A]);

		close(w, A);
		const report = await settle(world, [w], w);

		assert.deepEqual(report.dropped, [A]);
		assert.deepEqual(await w.committed(), [], "the catalog no longer commits it");
		assert.equal(w.index.slotBinding(A), null);
		assert.deepEqual(w.watch.tracked(), [], "and the window stops watching for it");
		assert.ok(w.index.get(row.tabId), "the conversation is untouched");
	});

	it("drops nothing before a whole settle interval has passed, and a slot that comes back is not due", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);

		close(w, A);
		world.advance(EDITOR_SLOT_SETTLE_MS - 1_000);
		await w.publish();
		assert.deepEqual((await w.pruner.run()).dropped, []);
		assert.deepEqual(await w.committed(), [A], "29 s is not a settled absence");

		// The tab is dragged to the other group and back: it is there again before the interval ends.
		w.membership.add(A);
		w.pruner.observe();
		world.advance(2_000);
		await w.publish();
		assert.deepEqual((await w.pruner.run()).dropped, []);
		world.advance(EDITOR_SLOT_SETTLE_MS * 4);
		await w.publish();
		assert.deepEqual((await w.pruner.run()).dropped, [], "an editor that is open is never due, however long");
		assert.deepEqual(await w.committed(), [A]);
	});

	it("never drops the binding of an editor this window holds, with another window alive", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const other = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await other.publish();

		const report = await settle(world, [w, other], w);

		assert.deepEqual(report, { held: null, dropped: [], handedOver: [], waiting: [] });
		assert.deepEqual(await w.committed(), [A]);
	});

	it("never drops a binding another window owns, closed there or open there", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const other = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await other.adopt();
		await other.bind(B, row.tabId);
		await other.bind(C, row.tabId);
		close(other, C); // closed in the other window, which has not pruned it yet
		await other.publish();

		close(w, A);
		const report = await settle(world, [w, other], w);

		assert.deepEqual(report.dropped, [A]);
		assert.deepEqual(await w.committed(), [B, C], "only the editor this window held and saw close is dropped");
		assert.deepEqual(w.watch.tracked(), [], "this window never watched for the other window's slots");
	});

	it("does not drop a slot another window lists: an editor moved to it is that window's now", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const other = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);

		close(w, A);
		other.membership.add(A);
		const report = await settle(world, [w, other], w);

		assert.deepEqual(report.handedOver, [A]);
		assert.deepEqual(report.dropped, []);
		assert.deepEqual(await w.committed(), [A]);
		assert.deepEqual(w.watch.tracked(), [], "no longer this window's to prune");
	});

	it("waits for a window that has not published since the editor vanished, then decides on what it publishes", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const slow = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await slow.publish();

		world.advance(1_000);
		close(w, A);
		world.advance(EDITOR_SLOT_SETTLE_MS);
		await w.publish(); // the other window's record is older than the moment the editor vanished here
		const early = await w.pruner.run();
		assert.deepEqual(early.waiting, [A]);
		assert.deepEqual(await w.committed(), [A]);

		slow.membership.add(A); // the editor arrived there before it published again
		await slow.publish();
		assert.deepEqual((await w.pruner.run()).handedOver, [A]);
		assert.deepEqual(await w.committed(), [A]);
	});

	it("is not raced by an opening: a binding committed before its editor shows in its window is nobody else's to judge", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const opening = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await opening.adopt();
		// The other window commits its binding before its tab shows in the tab set, and before its record lists it.
		await opening.index.bindEditorSlot(B, row.tabId, "passive");
		await opening.publish();
		assert.deepEqual(await w.committed(), [A, B]);

		close(w, A);
		const report = await settle(world, [w, opening], w);

		assert.deepEqual(report.dropped, [A]);
		assert.deepEqual(await w.committed(), [B], "the slot being opened is not this window's to judge");
		// Its tab appears, and later closes there: that window alone decides.
		opening.membership.add(B);
		opening.pruner.observe();
		await opening.publish();
		close(opening, B);
		assert.deepEqual((await settle(world, [w, opening], opening)).dropped, [B]);
		assert.deepEqual(await w.committed(), []);
	});

	it("decides nothing while a live window published no editor list", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const old = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);

		close(w, A);
		world.advance(EDITOR_SLOT_SETTLE_MS + 1_000);
		await w.publish();
		await old.publish({ slots: false }); // a window of an earlier build: its editors are unknown
		const held = await w.pruner.run();
		assert.match(held.held ?? "", /published no editor list/);
		assert.deepEqual(await w.committed(), [A]);
		assert.deepEqual(w.watch.tracked(), [A], "still watched");

		await old.publish();
		assert.deepEqual((await w.pruner.run()).dropped, [A], "decided as soon as it says what it holds");
	});

	it("leaves the bindings of a window that is gone alone: VS Code restores its editors with the window", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const gone = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await gone.adopt();
		await gone.bind(B, row.tabId);
		world.kill(gone);

		close(w, A);
		const report = await settle(world, [w], w);

		assert.deepEqual(report.dropped, [A], "a dead window's record does not hold a slot...");
		assert.deepEqual(await w.committed(), [B], "...and its own binding is nobody's to drop");
	});

	it("keeps a controlling binding, which broker provenance reads, and drops it once a later controller demotes it", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId, "controlling");

		close(w, A);
		const first = await settle(world, [w], w);
		assert.deepEqual(first.dropped, []);
		assert.deepEqual(await w.committed(), [A], "the conversation runs with no editor open: its controller is still the record of who started it");
		assert.deepEqual(w.watch.tracked(), [A]);

		await w.bind(B, row.tabId, "controlling"); // a new editor takes control and demotes the closed one
		assert.equal(w.index.slotBinding(A)?.role, "passive");
		const second = await settle(world, [w], w);
		assert.deepEqual(second.dropped, [A]);
		assert.deepEqual(await w.committed(), [B]);
	});

	it("judges a binding as committed now: one another window promoted in the meantime stays", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const other = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await other.adopt();
		await other.index.bindEditorSlot(A, row.tabId, "controlling");

		close(w, A);
		world.advance(EDITOR_SLOT_SETTLE_MS + 1_000);
		await w.store.refresh(); // the catalog's watcher has reported the other window's commit
		await w.publish();
		await other.publish();
		const report = await w.pruner.run();

		assert.deepEqual(report.dropped, []);
		assert.deepEqual(await w.committed(), [A]);
		assert.equal(w.index.slotBinding(A)?.role, "controlling");
	});

	it("never deletes a binding another window changed after this one adopted it: the merge keeps the change", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one");
		const other = await world.openWindow("window-two");
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		await other.adopt();
		await other.index.bindEditorSlot(A, row.tabId, "controlling"); // not yet reported to this window

		close(w, A);
		await settle(world, [w, other], w);

		assert.deepEqual(await w.committed(), [A], "the committed promotion survives the deletion");
		await w.adopt();
		assert.equal(w.index.slotBinding(A)?.role, "controlling");
	});

	it("decides nothing until the tab set is known to be complete: a restored tab may not be listed yet", async () => {
		const world = await profile();
		const w = await world.openWindow("window-one", undefined, { complete: false });
		const row = await w.index.createDraft({ cwd: world.cwd });
		await w.bind(A, row.tabId);
		close(w, A);
		const early = await settle(world, [w], w);
		assert.match(early.held ?? "", /not known to be complete/);
		assert.deepEqual(await w.committed(), [A]);

		w.pruner.markComplete();
		assert.deepEqual((await w.pruner.run()).dropped, [A]);
	});

	it("survives an extension-host reload: an editor still open stays, one that closed before it goes after the interval", async () => {
		const world = await profile();
		const first = await world.openWindow("window-one");
		const row = await first.index.createDraft({ cwd: world.cwd });
		await first.bind(A, row.tabId);
		await first.bind(B, row.tabId);
		close(first, B); // closed a moment before the window reloaded: its settle clock died with the host
		first.registry.removeSync(); // a normal deactivation removes the window's record

		const second = await world.openWindow("window-one", first.local);
		await second.adopt();
		assert.deepEqual(second.watch.tracked(), [A, B], "what the earlier host had held is remembered");
		second.membership.add(A); // VS Code restored the editor that was still open
		second.pruner.observe();
		await second.publish();
		assert.deepEqual((await second.pruner.run()).dropped, [], "a reload is not evidence that anything closed");

		const report = await settle(world, [second], second);
		assert.deepEqual(report.dropped, [B]);
		assert.deepEqual(await second.committed(), [A]);
		assert.deepEqual(second.watch.tracked(), [A]);
	});

	it("remembers nothing from a local record it cannot read, and never tracks an id that is not a slot id", () => {
		const local = new MemoryStore();
		local.values.set(EDITOR_SLOT_WATCH_KEY, { version: 9, slots: [A] });
		assert.deepEqual(new EditorSlotWatch({ store: local }).tracked(), []);
		local.values.set(EDITOR_SLOT_WATCH_KEY, { version: 1, slots: [A, 7, "has space"] });
		const watch = new EditorSlotWatch({ store: local });
		assert.deepEqual(watch.tracked(), [A]);
		watch.observe(new Set(["not a slot", B]));
		assert.deepEqual(watch.tracked(), [A, B]);
	});
});
