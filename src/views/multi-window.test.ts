/**
 * Two simulated windows of one profile show the same Sessions content (ADR-0056).
 *
 * Each window has its own folders, its own live facts, its own ownership observations and
 * its own `WindowRegistry` over one shared temporary directory; everything shared — the
 * index entries, the pinned folders — is the same object. The assertion is the projection:
 * folder rows, session rows, their order, label, description and icon are equal in both
 * windows in both arrangements, while the tooltip says which window holds a session.
 *
 * The provider imports the editor API, so this file maps `vscode` to the stand-in the way
 * `session-tree.test.ts` does.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import type { SessionIndexEntry } from "../host/session-index.ts";
import type { FolderPathInspector, WorkspaceFolderStore } from "./workspace-folders.ts";
import type { SessionActivityFacts, SessionLauncherFacts, SessionOwnershipFacts, SessionTreeItem, SessionTreeProvider, WorkspaceFolderTreeItem } from "./session-tree.ts";
import type { SessionsGrouping } from "./session-order.ts";
import type { PublishedRow } from "../host/window-registry.ts";

if (typeof module.registerHooks === "function") {
	const stubUrl = new URL("./vscode-test-stub.ts", import.meta.url).href;
	const EXTENSIONLESS = /^\.(?!.*\.[cm]?[jt]sx?$)/;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "vscode") return { url: stubUrl, shortCircuit: true };
			if (EXTENSIONLESS.test(specifier) && (context.parentURL ?? "").includes("/src/")) {
				for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`]) {
					try {
						return nextResolve(candidate, context);
					} catch {
						// Try the next extension.
					}
				}
			}
			return nextResolve(specifier, context);
		},
	});
}

const sessionTree = await import("./session-tree.ts");
const { LauncherFolders } = await import("./launcher-folders.ts");
const { WorkspaceFolderRegistry } = await import("./workspace-folders.ts");
const { WindowRegistry, sessionIncarnation } = await import("../host/window-registry.ts");

const NO_FACTS: SessionLauncherFacts = { open: false, running: false, outcome: null, activity: null };

function memoryStore(): WorkspaceFolderStore {
	const values = new Map<string, unknown>();
	return {
		get<T>(key: string): T | undefined {
			return values.get(key) as T | undefined;
		},
		update(key: string, value: unknown): unknown {
			values.set(key, value);
			return undefined;
		},
	};
}

function entry(overrides: Partial<SessionIndexEntry> & { readonly tabId: string; readonly cwd: string }): SessionIndexEntry {
	return {
		kind: "session",
		origin: "extension",
		sessionFile: path.join(os.tmpdir(), "omp-multi-window-missing", `${overrides.tabId.replace(/\W/g, "-")}.jsonl`),
		sessionId: null,
		scope: { profile: null, sessionDir: null },
		sessionDir: null,
		ownership: { ownerGeneration: `gen-${overrides.tabId.replace(/\W/g, "-")}`, draftIdentity: null, releasedAt: null },
		host: null,
		createdAt: "2026-09-25T10:00:00.000Z",
		lastActiveAt: "2026-09-25T10:05:00.000Z",
		ordinal: 0,
		availability: "saved",
		detail: null,
		runIntent: "stopped",
		title: null,
		lastCompletedReplyId: null,
		lastSeenReplyId: null,
		...overrides,
	};
}

function activity(overrides: Partial<SessionActivityFacts> = {}): SessionActivityFacts {
	return { pendingQuestion: false, working: false, backgroundWork: false, settled: true, trailingQuestion: false, lastCompletedReplyId: null, lastSeenReplyId: null, ...overrides };
}

function iconId(item: { readonly iconPath?: unknown }): string | undefined {
	const icon = item.iconPath;
	return typeof icon === "object" && icon !== null && "id" in icon ? String(icon.id) : undefined;
}

/** What one window knows by itself: its folders, the sessions it runs and what it observes of the claims. */
interface SimulatedWindow {
	readonly label: string;
	readonly holderId: string;
	readonly folders: string[];
	readonly running: Map<string, SessionLauncherFacts>;
	readonly held: Map<string, SessionOwnershipFacts>;
}

describe("two windows of one profile", () => {
	let temp: string;
	let FA: string;
	let FB: string;
	let PINNED: string;
	const registries: Array<InstanceType<typeof WindowRegistry>> = [];
	const providers: SessionTreeProvider[] = [];

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-multi-window-"));
		FA = path.join(temp, "folder-a");
		FB = path.join(temp, "folder-b");
		PINNED = path.join(temp, "pinned");
		for (const directory of [FA, FB, PINNED]) await fs.promises.mkdir(directory);
	});

	after(async () => {
		for (const provider of providers) provider.dispose();
		for (const registry of registries) registry.dispose();
		await fs.promises.rm(temp, { recursive: true, force: true });
	});

	const inspector: FolderPathInspector = {
		async inspect(rawPath: string) {
			return { ok: true, path: rawPath } as const;
		},
	};

	/** Everything for the scenario: A runs s1, B runs s2, s3 and s4 are stopped, one folder is pinned. */
	async function scenario(options: { s2Read?: boolean; activityOfS1?: string | null; activityOfS2?: string | null } = {}) {
		const pinnedStore = memoryStore();
		const entries = [
			entry({ tabId: "tab:s1", cwd: FA, ordinal: 1, runIntent: "running", availability: "live" }),
			entry({ tabId: "tab:s2", cwd: FB, ordinal: 2, runIntent: "running", availability: "live", lastCompletedReplyId: "r1", lastSeenReplyId: options.s2Read === true ? "r1" : "r0" }),
			entry({ tabId: "tab:s3", cwd: FA, ordinal: 3 }),
			entry({ tabId: "tab:s4", cwd: PINNED, ordinal: 4 }),
		];
		const generationOf = (tabId: string) => entries.find(candidate => candidate.tabId === tabId)!.ownership!.ownerGeneration;
		/** The run incarnation every window derives from the shared catalog entry. */
		const incarnationOf = (tabId: string) => sessionIncarnation(entries.find(candidate => candidate.tabId === tabId)!)!;
		const a: SimulatedWindow = { label: "window-a", holderId: "holder-a", folders: [FA], running: new Map(), held: new Map() };
		const b: SimulatedWindow = { label: "window-b", holderId: "holder-b", folders: [FB], running: new Map(), held: new Map() };
		a.running.set("tab:s1", { ...NO_FACTS, open: true, running: true, activity: activity({ working: true }) });
		b.running.set("tab:s2", { ...NO_FACTS, open: true, running: true, activity: activity({ lastCompletedReplyId: "r1", lastSeenReplyId: options.s2Read === true ? "r1" : "r0" }) });
		a.held.set("tab:s2", { heldElsewhere: true, heldBy: b.holderId, heldGeneration: generationOf("tab:s2"), ownershipChecked: true });
		b.held.set("tab:s1", { heldElsewhere: true, heldBy: a.holderId, heldGeneration: generationOf("tab:s1"), ownershipChecked: true });
		let grouping: SessionsGrouping = "flat";
		let tick = 0;
		const now = () => Date.parse("2026-10-10T10:00:00.000Z") + tick;
		const make = (window: SimulatedWindow, startedAt: string) => {
			const registry = new WindowRegistry({
				storageDir: temp, holderId: window.holderId, startedAt, now, pidAlive: () => true, writeDebounceMs: 1_000_000, heartbeatMs: 1_000_000,
			});
			registries.push(registry);
			const pinned = new WorkspaceFolderRegistry({ store: pinnedStore, inspector });
			return { registry, pinned };
		};
		const wa = make(a, "2026-10-10T09:00:00.000Z");
		const wb = make(b, "2026-10-10T09:01:00.000Z");
		await wa.pinned.add(PINNED);
		await wb.pinned.reload();
		const rowsFor = (window: SimulatedWindow): Record<string, PublishedRow> => {
			const rows: Record<string, PublishedRow> = {};
			// What the extension publishes: the owner's own status and activity, fenced to the run the catalog records.
			if (window === a) rows["tab:s1"] = { status: "working", incarnation: incarnationOf("tab:s1"), binding: "slot.1", lastActivityAt: options.activityOfS1 ?? null };
			if (window === b) rows["tab:s2"] = { status: "waiting", incarnation: incarnationOf("tab:s2"), binding: "slot.1", lastActivityAt: options.activityOfS2 ?? null };
			return rows;
		};
		const provider = (window: SimulatedWindow, registry: InstanceType<typeof WindowRegistry>, pinned: InstanceType<typeof WorkspaceFolderRegistry>) => {
			const folders = new LauncherFolders({
				pinned,
				local: memoryStore(),
				windows: () => registry.windows().map(open => ({ holderId: open.holderId, here: open.here, startedAt: open.startedAt, focusedAt: open.focusedAt, paths: open.folders })),
				showWindowFolders: () => true,
				liveSessionCwds: () => registry.windows().flatMap(open => open.liveCwds),
			});
			const created = new sessionTree.SessionTreeProvider({
				folders: () => folders.list(),
				entries: () => entries,
				activeTabId: () => null,
				facts: tabId => window.running.get(tabId) ?? NO_FACTS,
				runtimeIdentity: () => null,
				observeOwnership: async tabId => window.held.get(tabId) ?? { ownershipChecked: true },
				grouping: () => grouping,
				peer: (tabId, holderId, incarnation) => {
					const holder = registry.windows().find(open => !open.here && open.holderId === holderId);
					if (holder === undefined) return null;
					const published = holder.rows[tabId];
					const current = published !== undefined && incarnation !== null && published.incarnation === incarnation;
					return { status: current ? published.status : null, lastActivityAt: current ? published.lastActivityAt : null, window: holder.label };
				},
			});
			providers.push(created);
			return created;
		};
		const publishAll = async () => {
			for (const [window, handle] of [[a, wa], [b, wb]] as const) {
				handle.registry.setSnapshot({
					windowUri: null,
					label: window.label,
					folders: window.folders,
					liveCwds: [...window.running.keys()].map(tabId => entries.find(candidate => candidate.tabId === tabId)!.cwd),
					rows: rowsFor(window),
					focusedAt: null,
					stale: false,
				});
				await handle.registry.flush();
			}
			for (const handle of [wa, wb]) await handle.registry.refresh();
		};
		return {
			a, b, entries, wa, wb, publishAll, incarnationOf,
			providerA: provider(a, wa.registry, wa.pinned),
			providerB: provider(b, wb.registry, wb.pinned),
			setGrouping(next: SessionsGrouping) { grouping = next; },
			advance(ms: number) { tick += ms; },
		};
	}

	async function settle(provider: SessionTreeProvider): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt++) {
			provider.refresh();
			const roots = provider.getChildren();
			const rows = roots.flatMap(root => root instanceof sessionTree.WorkspaceFolderTreeItem ? provider.getChildren(root) : [root]);
			if (rows.every(row => !(row instanceof sessionTree.SessionTreeItem) || row.state !== "checking")) return;
			await nextTurn();
		}
		throw new Error("the rows never left Checking");
	}

	/** The tree as a user reads it: what must be equal in every window. */
	function content(provider: SessionTreeProvider): unknown[] {
		const dump = (item: SessionTreeItem | WorkspaceFolderTreeItem): unknown => item instanceof sessionTree.WorkspaceFolderTreeItem
			? { folder: item.id, label: item.label, description: item.description, icon: iconId(item), collapsed: item.collapsibleState, rows: provider.getChildren(item).map(child => child instanceof sessionTree.SessionTreeItem ? dump(child) : String(child.label)) }
			: { id: item.id, label: item.label, description: item.description, icon: iconId(item), unread: item.unread };
		return provider.getChildren().map(item => item instanceof sessionTree.SessionTreeItem || item instanceof sessionTree.WorkspaceFolderTreeItem ? dump(item) : String(item.label));
	}

	it("shows the same folders, sessions, order, text and icons in the flat list", async () => {
		const world = await scenario();
		await world.publishAll();
		await Promise.all([settle(world.providerA), settle(world.providerB)]);
		const seenByA = content(world.providerA);
		const seenByB = content(world.providerB);
		assert.deepEqual(seenByA, seenByB);
		const rows = seenByA.filter((item): item is { id: string; description: string; label: string } => typeof item === "object");
		assert.deepEqual(rows.map(row => row.id), ["tab:s2", "tab:s1", "tab:s4", "tab:s3"], "unread first, then live, then stopped");
		assert.deepEqual(rows.map(row => row.description), ["Unread reply", "Working", "Stopped", "Stopped"]);
		assert.ok(rows.every(row => row.label.includes(" · ")), "every row names its folder, and the folder of the other window is listed too");
	});

	it("shows the same folder tree in the by-folder arrangement", async () => {
		const world = await scenario();
		world.setGrouping("folders");
		await world.publishAll();
		await Promise.all([settle(world.providerA), settle(world.providerB)]);
		const seenByA = content(world.providerA);
		assert.deepEqual(seenByA, content(world.providerB));
		assert.equal(seenByA.length, 3, "folder A, folder B and the pinned folder, in the same order in both windows");
	});

	it("names the holding window in the tooltip and nowhere else", async () => {
		const world = await scenario();
		await world.publishAll();
		await Promise.all([settle(world.providerA), settle(world.providerB)]);
		const owner = (await world.providerA.itemFor("tab:s1"))!;
		const other = (await world.providerB.itemFor("tab:s1"))!;
		assert.equal(owner.state, "working");
		assert.equal(other.state, "otherWindow", "the menu contract of a row another window holds is unchanged");
		assert.match(String(owner.tooltip), /Open in this window/);
		assert.match(String(other.tooltip), /Open in another window: window-a/);
		assert.equal(other.description, owner.description);
		assert.equal(iconId(other), iconId(owner));
		assert.doesNotMatch(String(other.description), /another window/i);
	});

	it("keeps the status icon on a row another window runs and adds a badge after it, in that window only", async () => {
		const world = await scenario();
		await world.publishAll();
		await Promise.all([settle(world.providerA), settle(world.providerB)]);
		const badgeOf = (provider: SessionTreeProvider, row: SessionTreeItem) =>
			provider.decorations.provideFileDecoration(row.resourceUri!, undefined as never) as { badge: string; tooltip: string } | undefined;
		const owner = (await world.providerA.itemFor("tab:s1"))!;
		const other = (await world.providerB.itemFor("tab:s1"))!;
		assert.equal(iconId(other), iconId(owner), "the row's icon is the session's status icon in every window");
		assert.notEqual(iconId(other), "multiple-windows");
		assert.equal(badgeOf(world.providerA, owner), undefined, "the window that runs the session adds nothing");
		assert.deepEqual([badgeOf(world.providerB, other)?.badge, badgeOf(world.providerB, other)?.tooltip], ["\u29C9", "Open in another window"]);
		// An unread reply keeps its dot, and the held-elsewhere glyph follows it (tab:s2 is held by window B).
		const unreadHeld = (await world.providerB.itemFor("tab:s2"))!;
		const unreadElsewhere = (await world.providerA.itemFor("tab:s2"))!;
		assert.equal(badgeOf(world.providerA, unreadElsewhere)?.badge, "\u25CF\u29C9");
		assert.equal(badgeOf(world.providerB, unreadHeld)?.badge, "\u25CF", "in the holder window the unread dot is alone");
	});

	it("shows Running, not another window's stale status, once the catalog records another launch of the session", async () => {
		const world = await scenario();
		await world.publishAll();
		await Promise.all([settle(world.providerA), settle(world.providerB)]);
		assert.equal((await world.providerB.itemFor("tab:s1"))!.description, "Working");
		// A stop and relaunch keeps the claim's owner generation and records a new launch attempt.
		const before = world.incarnationOf("tab:s1");
		(world.entries.find(candidate => candidate.tabId === "tab:s1")! as { host: SessionIndexEntry["host"] }).host = { pid: 4242, instanceId: null, generation: null, sessionId: null, startedAt: "2026-10-10T09:50:00.000Z" };
		assert.notEqual(world.incarnationOf("tab:s1"), before);
		await settle(world.providerB);
		assert.equal((await world.providerB.itemFor("tab:s1"))!.description, "Running", "the earlier run's publication is not the new run's status");
		await world.publishAll();
		await settle(world.providerB);
		assert.equal((await world.providerB.itemFor("tab:s1"))!.description, "Working", "the owner's publication for the new run is applied");
	});

	it("orders a row another window runs by the activity its owner published, not by what this window happened to read", async () => {
		// No window has read a session file here: only the owner's published activity can tell the rows apart for an observer.
		const idsOf = (provider: SessionTreeProvider) => content(provider).filter((item): item is { id: string } => typeof item === "object").map(row => row.id);
		const without = await scenario({ s2Read: true });
		await without.publishAll();
		await settle(without.providerB);
		assert.deepEqual(idsOf(without.providerB).slice(0, 2), ["tab:s2", "tab:s1"], "with nothing published the newer ordinal decides");
		const published = await scenario({ s2Read: true, activityOfS1: "2026-10-10T09:59:00.000Z" });
		await published.publishAll();
		await settle(published.providerB);
		assert.deepEqual(idsOf(published.providerB).slice(0, 2), ["tab:s1", "tab:s2"], "the owner's newer published activity decides, although s2 has the newer ordinal");
	});

	it("drops a departed window's folder with its record, and shows Running without a window name once it is pinned", async () => {
		const world = await scenario();
		await world.publishAll();
		world.wa.registry.removeSync();
		await world.wb.registry.refresh();
		await settle(world.providerB);
		assert.equal(await world.providerB.itemFor("tab:s1"), undefined, "nothing pins the departed window's folder, so its rows leave with it");
		const added = await world.wb.pinned.add(FA);
		assert.ok(added.ok);
		await settle(world.providerB);
		const other = (await world.providerB.itemFor("tab:s1"))!;
		assert.equal(other.description, "Running", "the holder has published nothing any more");
		assert.doesNotMatch(String(other.tooltip), /window-a/);
	});
});
