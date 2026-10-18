/**
 * Window routing through its interface with fake dependencies: what this window publishes about itself,
 * where a launch or a session open starts, how a hand-over to another window ends, and what the window
 * does with a request another window addresses to it.
 *
 * Requests travel through real request directories in a temporary storage directory and real watches, as in
 * production; the registry, the launcher folders, the session index and the tabs are fakes the cases set.
 * `vscode` is the stand-in of `vscode-test-stub.ts`, so this file must run under `node --test`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import module from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { URI } from "vscode-uri";
import { sessionIncarnation } from "../host/window-registry.ts";
import type { WindowRegistry, WindowSnapshot } from "../host/window-registry.ts";
import { awaitPendingLaunchAnswer, awaitReloadTakenUp, awaitRequestAnswer, pendingKeyOf, postModelsRequest, postPendingLaunch, postReloadRequest, postSwitchRequest, startPendingLaunchWatch, startRequestWatch } from "../host/window-requests.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LaunchAction, LaunchRequest, ServeContext, ServeOutcome, StopRequest, SwitchRequest, WindowRequest } from "../host/window-requests.ts";
import type { StubTabGroup } from "./vscode-test-stub.ts";
import type { RoutedFolder, WindowRouting, WindowRoutingDeps } from "./window-routing.ts";

// The module and the launcher tree it imports load the `vscode` specifier; map it before the first import.
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

const stub = await import("./vscode-test-stub.ts");
const { owningWindowUri, registerWindowRouting } = await import("./window-routing.ts");

const STAMP = "2026-10-10T09:00:00.000Z";
const FOLDER = "C:/omp-vscode/proj";
const OWNER = "owner-test";
const wanted: ServeContext = { stillWanted: async () => true, progress: async () => {} };
const refused = { ok: false, focused: false };

let temp: string;
let created = 0;
const cleanups: Array<() => void> = [];
before(async () => { temp = await mkdtemp(path.join(tmpdir(), "omp-window-routing-")); });
after(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await rm(temp, { recursive: true, force: true });
});

interface OpeningWindow { holderId: string; here: boolean; startedAt: string; focusedAt: string | null; stale?: boolean }
interface FolderRow { id: string; path: string; collapsed: boolean; pinned: boolean; open: boolean; openHere: boolean; openElsewhere: boolean }
/** Another window the registry names, and whether (and how) a watch in the request directory answers for it. */
interface Target {
	readonly holderId: string;
	readonly uri: string | null;
	readonly serve: ServeOutcome | null;
	readonly pid?: number;
}

const folderRow = (overrides: Partial<FolderRow> = {}): FolderRow =>
	({ id: "folder:proj-1", path: FOLDER, collapsed: false, pinned: false, open: true, openHere: false, openElsewhere: true, ...overrides });
const there = (holderId: string, focusedAt: string | null = null): OpeningWindow => ({ holderId, here: false, startedAt: STAMP, focusedAt });
const here: OpeningWindow = { holderId: "this-window", here: true, startedAt: STAMP, focusedAt: null };
const opening = (open: Record<string, OpeningWindow[]>) => (folderPath: string): readonly OpeningWindow[] => open[folderPath] ?? [];

interface HeldEntry {
	tabId: string;
	cwd: string;
	ownership: { ownerGeneration: string } | null;
	host: { startedAt: string; pid: number | null } | null;
}

/**
 * This window, the windows it could hand a launch to (answering through the real request directory), and everything
 * it did: the notices it showed, the launches it started and the commands it ran.
 */
interface FakeRegistry {
	setSnapshot(snapshot: WindowSnapshot): boolean;
	refresh(): Promise<boolean>;
	flush(): Promise<void>;
	windows(): unknown[];
	liveHolderPid(holderId: string): number | null;
}
interface FakeIndex {
	readonly claimHolder: { readonly id: string };
	readonly claimStorageDir: string;
	get(tabId: string): HeldEntry | null;
	list(): HeldEntry[];
	observeOwnership(tabId: string): Promise<unknown>;
	hasLiveHost(tabId: string): boolean;
	slotBinding(slot: string): unknown;
}

/** `holderId` and `storageDir` make a second window of the same profile: it shares the request directory. */
async function world(targets: readonly Target[] = [], options: { readonly holderId?: string; readonly storageDir?: string } = {}) {
	const storageDir = options.storageDir ?? await mkdtemp(path.join(temp, `world-${created++}-`));
	const served: WindowRequest[] = [];
	for (const target of targets) {
		if (target.serve === null) continue;
		const watch = startRequestWatch(storageDir, target.holderId, async request => { served.push(request); return target.serve!; }, { debounceMs: 10 });
		cleanups.push(() => watch.dispose());
	}
	const state = {
		folders: [] as FolderRow[],
		opening: (() => []) as (folderPath: string, options?: { exact?: boolean }) => readonly OpeningWindow[],
		entries: new Map<string, HeldEntry>(),
		claim: null as unknown,
		liveHost: true,
		binding: { tabId: "", role: "controlling", mode: "chat", generation: 3 } as { tabId: string; role: string; mode: string; generation: number },
		tabs: new Map<string, { slotId: string; panel: unknown }>(),
		editorTabs: new Set<string>(),
		/** The tab set is not known to be complete yet (shortly after activation). */
		slotsUnknown: false,
		selectResult: true,
		noRegistry: false,
		published: [] as WindowSnapshot[],
		flushed: 0,
		refreshes: 0,
		stale: false,
		packageChanged: false,
		sessionFolders: async () => {},
		catalogReady: async () => {},
		startupCovers: false,
		unityStore: undefined as { get(key: string): unknown; update(key: string, value: unknown): Promise<void> } | undefined,
		processes: null as { serveStopRequest(rows: readonly unknown[], progress: (done: number) => Promise<void>): Promise<readonly unknown[]> } | null,
		liveFacts: new Map<string, Record<string, unknown>>(),
		activity: new Map<string, string>(),
		viewVisible: false,
		listed: [] as Array<{ item: { state: string; tabId: string }; folder: string }>,
	};
	const registry: FakeRegistry = {
		setSnapshot: snapshot => { state.published.push(snapshot); return true; },
		refresh: async () => { state.refreshes++; return false; },
		flush: async () => { state.flushed++; },
		windows: () => targets.map(target => ({ holderId: target.holderId, here: false, startedAt: STAMP, windowUri: target.uri, label: target.holderId, folders: [], liveCwds: [], rows: {}, focusedAt: null })),
		liveHolderPid: holderId => targets.find(target => target.holderId === holderId)?.pid ?? null,
	};
	const registryHandle = registry as unknown as WindowRegistry;
	const launcherFolders = {
		list: () => state.folders,
		get: (id: string) => state.folders.find(row => row.id === id) ?? null,
		folderForCwd: (cwd: string) => state.folders.find(row => row.path === cwd) ?? null,
		windowsWithFolder: (folderPath: string, options?: { exact?: boolean }) => state.opening(folderPath, options),
		identityKeyOf: (value: string) => value,
	};
	const drafts: unknown[] = [];
	const resumed: unknown[] = [];
	const opened: unknown[][] = [];
	const selected: string[] = [];
	const revealed: string[] = [];
	const elected: string[] = [];
	const openedTabs: unknown[][] = [];
	const warnings: string[] = [];
	const informed: string[] = [];
	const errors: string[] = [];
	const lines: LoggedLine[] = [];
	const released: unknown[] = [];
	const refreshedOwnership: string[][] = [];
	const refreshedLauncher: number[] = [];
	const providerRefreshes: unknown[] = [];
	const modelRefreshes: number[] = [];
	const requestSelections = new Set<string>();
	const fake: FakeIndex = {
		claimHolder: { id: options.holderId ?? "this-window" },
		claimStorageDir: storageDir,
		get: tabId => state.entries.get(tabId) ?? null,
		list: () => [...state.entries.values()],
		observeOwnership: async () => ({ ok: true, claim: state.claim }),
		hasLiveHost: () => state.liveHost,
		slotBinding: () => state.binding,
	};
	const deps: WindowRoutingDeps = {
		registry: () => state.noRegistry ? undefined : registryHandle,
		folders: () => launcherFolders as never,
		index: () => fake as never,
		refreshProviderModels: () => { modelRefreshes.push(Date.now()); },
		requestSelections: () => requestSelections,
		packageStale: () => state.stale,
		unityChoices: () => state.unityStore as never,
		startupRestoreCovers: () => state.startupCovers,
		resolveSessionFolders: () => state.sessionFolders(),
		packageChangedOnDisk: () => state.packageChanged,
		ensureCatalogReady: () => state.catalogReady(),
		sessionProcesses: () => state.processes as never,
		launcherProvider: () => ({
			lastActivityOf: tabId => state.activity.get(tabId) ?? null,
			refreshOwnership: tabIds => { refreshedOwnership.push([...tabIds]); },
			refresh: options => { providerRefreshes.push(options); },
			listedSessions: () => state.listed as never,
		}),
		sessionsViewVisible: () => state.viewVisible,
		refreshLauncher: () => { refreshedLauncher.push(Date.now()); },
		facts: tabId => (state.liveFacts.get(tabId) ?? { open: false, running: false, outcome: null, activity: null }) as never,
		releaseSelection: target => { released.push(target); },
		tab: tabId => state.tabs.get(tabId) as never,
		hasEditorTab: slot => state.editorTabs.has(slot),
		liveEditorSlots: () => (state.slotsUnknown ? null : [...state.editorTabs]),
		selectEditorTab: async slot => { selected.push(slot); return state.selectResult; },
		revealExistingTab: async (_index, tabId) => { revealed.push(tabId); },
		isSessionTabInput: input => input !== null && typeof input === "object" && "session" in input,
		electLocalController: async (_index, tabId) => { elected.push(tabId); },
		openSession: async (...args) => { opened.push(["open-session", ...args.slice(2)]); return true; },
		openSessionInMode: async (...args) => { opened.push(["open-session-in-mode", ...args.slice(2)]); },
		startNewSession: async (_context, _index, folder) => { drafts.push({ cwd: folder.path }); },
		resumeFromFolderHistory: async (_context, _index, _folders, folder, keepLiveView) => { resumed.push({ cwd: folder.path, keepLiveView }); },
		openTab: async (...args) => { openedTabs.push(args.slice(2)); },
		log: recordingLogger(lines),
		timing: () => {},
		info: message => { informed.push(message); },
		warn: message => { warnings.push(message); },
		error: message => { errors.push(message); },
	};
	const routing = registerWindowRouting(deps);
	stub.commands.calls.length = 0;
	stub.commands.handler = null;
	stub.window.state.focused = true;
	return {
		storageDir, served, state, deps, routing, registry, registryHandle, fake, index: fake as never, calls: stub.commands.calls, drafts, resumed, opened, selected, revealed, elected, openedTabs,
		warnings, informed, errors, get logged(): string[] { return lines.map(line => line.message); }, lines, released, refreshedOwnership, refreshedLauncher, providerRefreshes, modelRefreshes, requestSelections,
	};
}

type World = Awaited<ReturnType<typeof world>>;

const request = (launch: LaunchAction, workspace: LaunchRequest["workspace"] = { path: FOLDER, match: "folder" }): LaunchRequest =>
	({ kind: "launch", version: 1, id: "id-1", to: "this-window", from: "holder-a", createdAt: STAMP, workspace, launch } as LaunchRequest);
const newSession: LaunchAction = { kind: "new-session", folderId: "folder:proj-1" };
const folderLeft = async (w: World, directory: string, suffix: string) =>
	(await readdir(path.join(w.storageDir, directory))).filter(name => name.endsWith(suffix));

describe("the identity of this window", () => {
	it("is a saved workspace for multiple roots, the folder for one root, and none for an unsaved multi-root window", () => {
		const one = URI.file("C:/omp-vscode/one");
		const two = URI.file("C:/omp-vscode/two");
		const saved = URI.file("C:/omp-vscode/omp-vscode.code-workspace");
		const set = (file: URI | undefined, folders: URI[]) => {
			stub.workspace.workspaceFile = file;
			stub.workspace.workspaceFolders = folders.map(uri => ({ uri }));
		};
		try {
			set(undefined, [one]);
			assert.equal(owningWindowUri()?.toString(), one.toString());
			set(undefined, [one, two]);
			assert.equal(owningWindowUri(), null);
			set(saved, [one, two]);
			assert.equal(owningWindowUri()?.toString(), saved.toString());
			set(URI.parse("untitled:workspace"), [one]);
			assert.equal(owningWindowUri(), null);
		} finally {
			set(undefined, []);
		}
	});
});

describe("what this window publishes", () => {
	const entry = (tabId: string, cwd: string, overrides: Record<string, unknown> = {}) =>
		({ tabId, cwd, kind: "session", ordinal: 1, sessionFile: "s.jsonl", availability: "live", runIntent: "running", ownership: { ownerGeneration: OWNER }, host: { startedAt: STAMP, pid: 7 }, ...overrides }) as HeldEntry;

	it("names its folders, the working directories of the sessions it runs, each live row with the run and binding it was published for, and whether it is stale", async () => {
		const w = await world();
		stub.workspace.workspaceFolders = [{ uri: URI.file("C:/omp-vscode/one") }, { uri: URI.parse("vscode-remote://host/two") }];
		stub.workspace.name = "one";
		try {
			w.state.entries.set("tab:running", entry("tab:running", "C:/omp-vscode/one"));
			w.state.entries.set("tab:starting", entry("tab:starting", "C:/omp-vscode/two"));
			w.state.entries.set("tab:unread", entry("tab:unread", "C:/omp-vscode/three"));
			w.state.entries.set("tab:stopped", entry("tab:stopped", "C:/omp-vscode/four", { availability: "saved" }));
			w.state.entries.set("tab:no-owner", entry("tab:no-owner", "C:/omp-vscode/five", { ownership: null }));
			w.state.liveFacts.set("tab:running", { open: true, running: true, outcome: null, activity: null });
			w.state.liveFacts.set("tab:starting", { open: false, running: false, launching: true, outcome: null, activity: null });
			w.state.liveFacts.set("tab:unread", { open: true, running: true, outcome: null, activity: { pendingQuestion: false, working: false, backgroundWork: false, settled: true, lastCompletedReplyId: "r2", lastSeenReplyId: "r1" } });
			w.state.liveFacts.set("tab:no-owner", { open: true, running: true, outcome: null, activity: null });
			w.state.tabs.set("tab:running", { slotId: "a".repeat(32), panel: null });
			w.state.binding = { tabId: "tab:running", role: "controlling", mode: "chat", generation: 4 };
			w.state.activity.set("tab:running", "2026-10-10T10:00:00.000Z");
			w.state.stale = true;
			w.routing.publishSnapshot();
			const snapshot = w.state.published.at(-1)!;
			assert.deepEqual(snapshot.folders, [path.normalize("C:/omp-vscode/one")].map(() => URI.file("C:/omp-vscode/one").fsPath));
			assert.equal(snapshot.label, "one");
			assert.equal(snapshot.windowUri, null, "two roots and no saved workspace have no reopenable identity");
			assert.deepEqual(snapshot.liveCwds, ["C:/omp-vscode/one", "C:/omp-vscode/two", "C:/omp-vscode/three", "C:/omp-vscode/five"]);
			assert.deepEqual(Object.keys(snapshot.rows).sort(), ["tab:running", "tab:starting", "tab:unread"], "a stopped row and a row without an owner generation are not published");
			assert.deepEqual(snapshot.rows["tab:running"], { status: "running", incarnation: sessionIncarnation(w.state.entries.get("tab:running")!), binding: `${"a".repeat(32)}.4`, lastActivityAt: "2026-10-10T10:00:00.000Z" });
			assert.equal(snapshot.rows["tab:starting"]?.status, "starting");
			assert.equal(snapshot.rows["tab:starting"]?.binding, "none", "no editor serves it yet");
			assert.equal(snapshot.rows["tab:unread"]?.status, "waiting", "unread is published as the idle status it sits on");
			assert.equal(snapshot.stale, true);
			assert.equal(snapshot.focusedAt, null, "this window was never focused");
		} finally {
			stub.workspace.workspaceFolders = undefined;
			stub.workspace.name = undefined;
		}
	});

	it("names the folders whose sessions stay in the folder because ompDesk.runSessionsAtRepositoryRoot is off, and none by default", async () => {
		const w = await world();
		stub.workspace.workspaceFolders = [{ uri: URI.file("C:/omp-vscode/one") }];
		try {
			w.routing.publishSnapshot();
			assert.equal(w.state.published.at(-1)?.staysInFolder, undefined, "on by default: nothing to publish");
			stub.workspace.settings["ompDesk.runSessionsAtRepositoryRoot"] = false;
			w.routing.publishSnapshot();
			assert.deepEqual(w.state.published.at(-1)?.staysInFolder, [URI.file("C:/omp-vscode/one").fsPath]);
		} finally {
			delete stub.workspace.settings["ompDesk.runSessionsAtRepositoryRoot"];
			stub.workspace.workspaceFolders = undefined;
		}
	});

	it("carries the moment this window was last brought to the front", async () => {
		const w = await world();
		w.routing.publishSnapshot();
		assert.equal(w.state.published.at(-1)?.focusedAt, null);
		const before = Date.now();
		w.routing.noteFocused();
		w.routing.publishSnapshot();
		const focusedAt = w.state.published.at(-1)?.focusedAt;
		assert.ok(typeof focusedAt === "string" && Date.parse(focusedAt) >= before);
	});

	it("publishes the editor slots VS Code holds in this window, in a stable order, an empty list when there is none", async () => {
		const w = await world();
		w.routing.publishSnapshot();
		assert.deepEqual(w.state.published.at(-1)?.slots, [], "no editor is a published fact, not an unknown one");
		w.state.editorTabs.add("b".repeat(32));
		w.state.editorTabs.add("a".repeat(32));
		w.routing.publishSnapshot();
		assert.deepEqual(w.state.published.at(-1)?.slots, ["a".repeat(32), "b".repeat(32)]);
	});

	it("leaves the editor slots out of the record while the tab set is not known to be complete: unknown, never none", async () => {
		const w = await world();
		w.state.slotsUnknown = true;
		w.routing.publishSnapshot();
		assert.equal("slots" in w.state.published.at(-1)!, false);
		w.state.slotsUnknown = false;
		w.routing.publishSnapshot();
		assert.deepEqual(w.state.published.at(-1)?.slots, []);
	});

	it("publishes nothing while there is no registry or no index", async () => {
		const w = await world();
		w.state.noRegistry = true;
		w.routing.publishSnapshot();
		assert.deepEqual(w.state.published, []);
	});
});

describe("keeping the registry's picture current", () => {
	it("flushes this window's record and reads the others', repainting only when what they show changed", async () => {
		const w = await world();
		let changed = false;
		w.registry.refresh = async () => changed;
		w.routing.refresh();
		await nextTurn();
		assert.equal(w.state.published.length, 0);
		assert.equal(w.state.flushed, 1);
		assert.equal(w.refreshedLauncher.length, 0, "nothing changed");
		changed = true;
		w.routing.refresh();
		await nextTurn(); await nextTurn();
		assert.equal(w.refreshedLauncher.length, 1, "what the other windows show changed");
		w.registry.refresh = async () => { throw new Error("unreadable"); };
		w.routing.refresh();
		await nextTurn(); await nextTurn();
		assert.ok(w.logged.some(line => line === "window registry: unreadable"));
	});

	it("re-probes the session folders and repaints when another window's folders changed, and lists every folder of every window", async () => {
		const w = await world();
		let probes = 0;
		w.state.sessionFolders = async () => { probes++; };
		w.registry.windows = () => [{ folders: ["C:/a", "C:/b"] }, { folders: ["C:/c"] }];
		assert.deepEqual(w.routing.allFolders(), ["C:/a", "C:/b", "C:/c"]);
		w.routing.registryChanged();
		assert.equal(probes, 1);
		assert.equal(w.refreshedLauncher.length, 1);
	});

	it("tells the other windows apart from this one", async () => {
		const w = await world();
		w.registry.windows = () => [{ holderId: "me", here: true }, { holderId: "b", here: false }];
		assert.deepEqual(w.routing.peers().map(window => window.holderId), ["b"]);
		assert.equal(w.routing.registry(), w.registryHandle);
	});

	describe("the heartbeat", () => {
		it("re-probes the session folders, and observes every row again while the Sessions view is visible", async () => {
			const w = await world();
			let probes = 0;
			w.state.sessionFolders = async () => { probes++; };
			w.state.viewVisible = true;
			w.routing.heartbeat();
			assert.equal(probes, 1);
			assert.deepEqual(w.providerRefreshes, [{ ownership: true }]);
			assert.deepEqual(w.refreshedOwnership, []);
		});

		it("observes only the rows another window holds or that are still Checking while the view is hidden", async () => {
			const w = await world();
			w.state.listed = [
				{ item: { state: "otherWindow", tabId: "tab:other" }, folder: FOLDER },
				{ item: { state: "running", tabId: "tab:own" }, folder: FOLDER },
				{ item: { state: "checking", tabId: "tab:checking" }, folder: FOLDER },
			];
			w.routing.heartbeat();
			assert.deepEqual(w.providerRefreshes, []);
			assert.deepEqual(w.refreshedOwnership, [["tab:other", "tab:checking"]]);
			w.state.listed = [{ item: { state: "running", tabId: "tab:own" }, folder: FOLDER }];
			w.routing.heartbeat();
			assert.equal(w.refreshedOwnership.length, 1, "nothing to repair");
		});
	});
});

describe("switching to the window that holds a session", () => {
	const TAB = "tab:11111111-2222-4333-8444-555555555555";

	/** A holder whose claim names `windowUri`, and a directory where requests to it are served (or not). */
	async function holderOf(windowUri: string | null, serve: ServeOutcome | null) {
		const w = await world();
		const owner = { id: "owner-window", pid: 4242 };
		const watch = serve === null ? null : startRequestWatch(w.storageDir, owner.id, async request => { w.served.push(request); return serve; }, { debounceMs: 10 });
		cleanups.push(() => watch?.dispose());
		w.state.entries.set(TAB, { tabId: TAB, cwd: FOLDER, ownership: { ownerGeneration: "gen-1" }, host: null });
		w.state.claim = { verifiable: true, holderId: owner.id, pid: owner.pid, ownerGeneration: "gen-1", windowUri };
		w.registry.liveHolderPid = holderId => holderId === owner.id ? owner.pid : null;
		return w;
	}

	it("switches at once to the verified holder's workspace and has it select the tab, with no message", async () => {
		const target = URI.file("C:/omp-vscode/omp-vscode.code-workspace");
		const w = await holderOf(target.toString(), { ok: true, focused: true });
		await w.routing.switchToWindow(w.index, TAB);
		assert.equal(w.calls.length, 1, "nothing is launched and nothing else is run");
		assert.equal(w.calls[0]?.[0], "vscode.openFolder");
		assert.equal((w.calls[0]?.[1] as URI).toString(), target.toString());
		assert.deepEqual(w.calls[0]?.[2], { forceNewWindow: true }, "focus the owner; never replace this window if the owner just closed");
		assert.deepEqual(w.served.flatMap(served => served.kind === "select" ? [[served.tabId, served.incarnation]] : []), [[TAB, "gen-1_none"]]);
		assert.deepEqual([w.informed, w.warnings], [[], []], "a switch that works is silent");
		assert.equal(w.released.length, 1, "the selection goes back to this window's own session");
	});

	it("explains why, and does not try to open anything, when the owner has no window identity", async () => {
		const w = await holderOf(null, { ok: true, focused: true });
		await w.routing.switchToWindow(w.index, TAB);
		assert.equal(w.calls.length, 0);
		assert.equal(w.informed.length, 1);
		assert.match(w.informed[0]!, /no saved workspace or single-folder identity/);
		assert.match(w.informed[0]!, /tab is selected there/, "the owner was still asked to select it");
		assert.equal(w.served.length, 1);
	});

	it("says that the owner no longer has the editor, did not respond, or did not come to the front", async () => {
		const target = URI.file("C:/omp-vscode/other.code-workspace").toString();
		const refusing = await holderOf(target, { ok: false, focused: false });
		await refusing.routing.switchToWindow(refusing.index, TAB);
		assert.match(refusing.informed[0] ?? "", /no longer has an editor open/);
		assert.deepEqual(refusing.refreshedOwnership, [[TAB]], "the row is observed again");
		const unfocused = await holderOf(target, { ok: true, focused: false });
		await unfocused.routing.switchToWindow(unfocused.index, TAB);
		assert.match(unfocused.informed[0] ?? "", /did not bring it to the front/);
		assert.deepEqual([refusing.warnings, unfocused.warnings], [[], []]);
	});

	it("says that the session is no longer open elsewhere when the claim went away", async () => {
		const w = await holderOf(URI.file("C:/omp-vscode/x.code-workspace").toString(), null);
		w.state.claim = null;
		await w.routing.switchToWindow(w.index, TAB);
		assert.deepEqual(w.informed, ["The session is no longer open in another window."]);
		assert.equal(w.calls.length, 0);
	});

	it("switches nowhere for a command that names no tab, and still puts the selection back", async () => {
		const w = await world();
		await w.routing.switchToWindow(w.index, null);
		assert.deepEqual([w.calls, w.informed, w.warnings, w.served], [[], [], [], []]);
		assert.equal(w.released.length, 1);
	});

	it("knows whether another window holds a session from one claim read", async () => {
		const w = await holderOf(null, null);
		assert.equal(await w.routing.heldByAnotherWindow(w.index, TAB), true);
		w.state.claim = { verifiable: true, holderId: "this-window", pid: 4242, ownerGeneration: "gen-1", windowUri: null };
		assert.equal(await w.routing.heldByAnotherWindow(w.index, TAB), false, "this window's own claim");
		w.state.claim = { verifiable: true, holderId: "gone-window", pid: 1, ownerGeneration: "gen-1", windowUri: null };
		assert.equal(await w.routing.heldByAnotherWindow(w.index, TAB), false, "a holder the registry does not show live is not taken for alive without its own probe");
		w.state.claim = null;
		assert.equal(await w.routing.heldByAnotherWindow(w.index, TAB), false);
	});
});

describe("starting a session in the window that has its folder open", () => {
	after(() => {
		stub.workspace.settings = {};
		stub.window.showQuickPick = async items => { stub.window.picks.push(items); return undefined; };
	});

	const hand = (w: World, folder: RoutedFolder = { path: FOLDER }, timeoutMs?: number, launch: LaunchAction = newSession) =>
		w.routing.routeLaunch(w.index, folder, launch, timeoutMs);

	it("hands New Session for a folder only another window has open to that window, silently", async () => {
		const target = URI.file("C:/omp-vscode/proj");
		const w = await world([{ holderId: "holder-b", uri: target.toString(), serve: { ok: true, focused: true } }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		assert.equal(await hand(w), true, "handed over: the caller starts nothing");
		assert.equal(w.served.length, 1);
		const served = w.served[0]!;
		assert.deepEqual(served.kind === "launch" ? [served.launch, served.workspace, served.to] : null, [newSession, { path: FOLDER, match: "folder" }, "holder-b"]);
		assert.equal(w.calls.length, 1);
		assert.equal(w.calls[0]?.[0], "vscode.openFolder");
		assert.equal((w.calls[0]?.[1] as URI).toString(), target.toString());
		assert.deepEqual(w.calls[0]?.[2], { forceNewWindow: true });
		assert.deepEqual([w.warnings, w.informed], [[], []], "a hand-over that works is silent");
	});

	it("starts here when this window has the folder, however many others have it too", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///b", serve: { ok: true, focused: true } }]);
		w.state.opening = opening({ [FOLDER]: [here, there("holder-b")] });
		assert.equal(await hand(w), false);
		assert.deepEqual([w.served, w.calls], [[], []]);
	});

	it("starts here when no live window has the folder (a pinned folder, or one a session keeps visible)", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///b", serve: { ok: true, focused: true } }]);
		assert.equal(await hand(w), false);
		assert.deepEqual([w.served, w.calls], [[], []]);
	});

	it("starts here, whatever other windows have open, when ompDesk.launchInFolderWindow is off", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///b", serve: { ok: true, focused: true } }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		stub.workspace.settings = { "ompDesk.launchInFolderWindow": false };
		try {
			assert.equal(await hand(w), false);
		} finally { stub.workspace.settings = {}; }
		assert.deepEqual([w.served, w.calls], [[], []]);
	});

	it("goes to the most recently focused of several other windows and asks only that one", async () => {
		const w = await world([
			{ holderId: "holder-old", uri: URI.file("C:/omp-vscode/old.code-workspace").toString(), serve: { ok: true, focused: true } },
			{ holderId: "holder-new", uri: URI.file("C:/omp-vscode/new.code-workspace").toString(), serve: { ok: true, focused: true } },
		]);
		w.state.opening = opening({ [FOLDER]: [there("holder-old", "2026-10-10T09:10:00.000Z"), there("holder-new", "2026-10-10T09:50:00.000Z")] });
		assert.equal(await hand(w), true);
		assert.deepEqual(w.served.map(served => served.to), ["holder-new"]);
		assert.equal((w.calls[0]?.[1] as URI).toString(), URI.file("C:/omp-vscode/new.code-workspace").toString());
	});

	it("says so, and starts nothing here, when the window refuses", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///c%3A/b", serve: { ok: false, focused: false } }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		assert.equal(await hand(w), true);
		assert.equal(w.served.length, 1);
		assert.match(w.warnings[0] ?? "", /could not start the session/);
		assert.equal(w.refreshedLauncher.length, 1, "the launcher is repainted: the folder may have closed there");
	});

	it("says so, withdraws the request and starts nothing here when the window does not answer", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///c%3A/b", serve: null }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		assert.equal(await hand(w, { path: FOLDER }, 150), true);
		assert.match(w.warnings[0] ?? "", /did not respond in time/);
		assert.match(w.warnings[0] ?? "", /Nothing was started from here/);
		assert.deepEqual(await folderLeft(w, "window-requests", ".request"), [], "the unanswered request is withdrawn, so the window cannot start it late");
	});

	it("ends its wait at the deadline even when VS Code never finishes focusing the window, and withdraws the request", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///c%3A/b", serve: null }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		stub.commands.handler = () => new Promise(() => {});
		const started = Date.now();
		assert.equal(await hand(w, { path: FOLDER }, 200), true);
		assert.ok(Date.now() - started < 3_000, "the command is not held by the focus command");
		assert.match(w.warnings[0] ?? "", /did not respond in time/);
		assert.deepEqual(await folderLeft(w, "window-requests", ".request"), []);
	});

	it("says the session may have started when VS Code fails to focus a window that was asked, and withdraws the request", async () => {
		const w = await world([{ holderId: "holder-b", uri: "file:///c%3A/b", serve: null }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		stub.commands.handler = () => { throw new Error("no such window"); };
		assert.equal(await hand(w, { path: FOLDER }, 3_000), true);
		assert.match(w.warnings[0] ?? "", /could not bring the window that has this folder open forward/);
		assert.match(w.warnings[0] ?? "", /may have started there/);
		assert.deepEqual(await folderLeft(w, "window-requests", ".request"), []);
	});

	it("explains a window it cannot bring forward, which still starts the session", async () => {
		const w = await world([{ holderId: "holder-b", uri: null, serve: { ok: true, focused: true } }]);
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		assert.equal(await hand(w), true);
		assert.equal(w.served.length, 1);
		assert.deepEqual(w.calls, []);
		assert.match(w.informed[0] ?? "", /cannot bring that window forward/);
	});

	describe("a window that runs an older OMP Desk than the one installed", () => {
		const oldBuild = (holderId: string, focusedAt: string | null = null): OpeningWindow => ({ ...there(holderId, focusedAt), stale: true });
		const answers = { ok: true, focused: true } as const;

		it("is never handed a launch: the launch starts here, and the user is told once", async () => {
			const w = await world([{ holderId: "holder-old-1", uri: URI.file(FOLDER).toString(), serve: answers }]);
			w.state.opening = opening({ [FOLDER]: [oldBuild("holder-old-1")] });
			assert.equal(await hand(w), false);
			assert.deepEqual(w.served, [], "nothing is asked of the window");
			assert.deepEqual(w.calls, [], "and it is not brought forward");
			assert.equal(w.informed.length, 1);
			assert.match(w.informed[0]!, /window with proj runs an older OMP Desk build; reload it \(Developer: Reload Window\)\. The session opened here\./);
			assert.equal(await hand(w), false);
			assert.equal(w.informed.length, 1, "the same window is not announced again");
			assert.ok(w.logged.filter(line => line.includes("run an older OMP Desk build")).length === 2, "but always logged");
		});

		it("loses to a window on the current build even when it was focused last", async () => {
			const w = await world([
				{ holderId: "holder-old-2", uri: "file:///old", serve: answers },
				{ holderId: "holder-new-2", uri: "file:///new", serve: answers },
			]);
			w.state.opening = opening({ [FOLDER]: [oldBuild("holder-old-2", "2026-10-10T12:00:00.000Z"), there("holder-new-2", "2026-10-10T09:30:00.000Z")] });
			assert.equal(await hand(w), true);
			assert.deepEqual(w.served.map(served => served.to), ["holder-new-2"]);
			assert.deepEqual([w.warnings, w.informed], [[], []]);
		});

		it("starts the launch here when the window it was handed to refuses it as an older build, and says so once", async () => {
			const w = await world([{ holderId: "holder-old-3", uri: URI.file(FOLDER).toString(), serve: { ok: false, focused: false, refusal: "stale-build" } }]);
			// Not yet published as stale: the request reaches it and it answers with the definite refusal.
			w.state.opening = opening({ [FOLDER]: [there("holder-old-3")] });
			assert.equal(await hand(w), false, "having begun nothing, the caller starts the launch here");
			assert.equal(w.served.length, 1, "it was asked once");
			assert.deepEqual(w.warnings, [], "this is not the \"could not start\" refusal");
			assert.match(w.informed[0] ?? "", /runs an older OMP Desk build; reload it/);
			assert.equal(await hand(w), false);
			assert.equal(w.informed.length, 1);
		});
	});

	describe("opening a session row", () => {
		const TAB = "tab:99999999-1111-4222-8333-444444444444";
		const entry = { tabId: TAB, cwd: FOLDER, ownership: null, host: null };

		it("hands a stopped session of a folder only another window has open to that window, in the view asked for", async () => {
			const w = await world([{ holderId: "holder-b", uri: URI.file("C:/omp-vscode/proj").toString(), serve: { ok: true, focused: true } }]);
			w.state.entries.set(TAB, entry);
			w.state.folders = [folderRow()];
			w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
			assert.equal(await w.routing.routeOpen(w.index, TAB, "resumed", "terminal"), true);
			const served = w.served[0]!;
			assert.deepEqual(served.kind === "launch" ? [served.launch, served.workspace] : null, [{ kind: "open-session", tabId: TAB, verb: "resumed", mode: "terminal" }, { path: FOLDER, match: "folder" }]);
			assert.equal(w.calls[0]?.[0], "vscode.openFolder");
		});

		it("leaves alone a session when this window has the folder, one it already shows only to look at, and one it has no folder for", async () => {
			const w = await world([{ holderId: "holder-b", uri: "file:///c%3A/b", serve: { ok: true, focused: true } }]);
			w.state.entries.set(TAB, entry);
			w.state.folders = [folderRow({ openHere: true })];
			w.state.opening = opening({ [FOLDER]: [here, there("holder-b")] });
			assert.equal(await w.routing.routeOpen(w.index, TAB, "resumed", null), false, "the folder is open here");
			w.state.folders = [folderRow()];
			w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
			w.state.tabs.set(TAB, { slotId: "a".repeat(32), panel: null });
			assert.equal(await w.routing.routeOpen(w.index, TAB, "opened", null), false, "an editor this window already has is only revealed");
			w.state.tabs.clear();
			w.state.folders = [];
			assert.equal(await w.routing.routeOpen(w.index, TAB, "resumed", null), false, "a session whose folder is unknown starts here");
			assert.equal(await w.routing.routeOpen(w.index, "tab:unknown", "resumed", null), false);
			assert.deepEqual([w.served, w.calls], [[], []]);
		});
	});

	describe("a Unity project", () => {
		let unityRoot: string;
		before(async () => { unityRoot = await mkdtemp(path.join(temp, "unity-")); });
		const makeProject = async (directory: string) => {
			await mkdir(path.join(directory, "ProjectSettings"), { recursive: true });
			await mkdir(path.join(directory, "Assets"), { recursive: true });
			await writeFile(path.join(directory, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
		};
		/** A repository folder with a Unity project below it, as the Sessions folder (the session folder). */
		const repoWith = async (name: string, ...projects: string[]) => {
			const repo = path.join(unityRoot, name);
			await mkdir(repo, { recursive: true });
			for (const project of projects) await makeProject(path.join(repo, project));
			return repo;
		};
		const launch: LaunchAction = { kind: "new-session", folderId: "folder:repo-1" };

		it("goes to a window that has the project open, though the session folder is open here", async () => {
			const repo = await repoWith("repo-other", "omp-vscode");
			const unity = path.join(repo, "omp-vscode");
			const w = await world([{ holderId: "holder-unity", uri: URI.file(unity).toString(), serve: { ok: true, focused: true } }]);
			w.state.opening = opening({ [repo]: [here], [unity]: [there("holder-unity")] });
			assert.equal(await hand(w, { path: repo }, undefined, launch), true);
			const served = w.served[0]!;
			assert.deepEqual(served.kind === "launch" ? [served.launch, served.workspace] : null, [launch, { path: unity, match: "root" }], "the session's folder stays the repository; the window is the project's");
			assert.equal((w.calls[0]?.[1] as URI).toString(), URI.file(unity).toString());
		});

		it("starts here when this window has the project open itself", async () => {
			const repo = await repoWith("repo-here", "omp-vscode");
			const unity = path.join(repo, "omp-vscode");
			const w = await world([]);
			w.state.opening = opening({ [unity]: [here] });
			assert.equal(await hand(w, { path: repo }, undefined, launch), false);
			assert.deepEqual(w.calls, []);
		});

		it("opens a new window on the project, leaving the launch for it, when no window has it open", async () => {
			const repo = await repoWith("repo-none", "omp-vscode");
			const unity = path.join(repo, "omp-vscode");
			const w = await world([]);
			w.state.opening = opening({ [repo]: [here] });
			const claimed: WindowRequest[] = [];
			const watch = startPendingLaunchWatch(w.storageDir, "holder-new", () => [pendingKeyOf(unity)], async pending => { claimed.push(pending); return { ok: true, focused: true }; }, { debounceMs: 10 });
			cleanups.push(() => watch.dispose());
			assert.equal(await hand(w, { path: repo }, undefined, launch), true);
			assert.equal(w.calls.length, 1);
			assert.equal(w.calls[0]?.[0], "vscode.openFolder");
			assert.ok((w.calls[0]?.[1] as URI).fsPath.toLowerCase().endsWith(path.join("repo-none", "omp-vscode").toLowerCase()), "the new window opens on the Unity project, not on the repository");
			assert.deepEqual(w.calls[0]?.[2], { forceNewWindow: true });
			const served = claimed[0]!;
			assert.deepEqual(served.kind === "launch" ? [served.launch, served.workspace, served.to] : null, [launch, { path: unity, match: "root" }, "holder-new"]);
			assert.deepEqual([w.warnings, w.informed], [[], []], "silent when the new window answers");
		});

		it("says so, withdraws the launch and starts nothing here when the new window never answers", async () => {
			const repo = await repoWith("repo-silent", "omp-vscode");
			const w = await world([]);
			assert.equal(await hand(w, { path: repo }, 150, launch), true);
			assert.match(w.warnings[0] ?? "", /did not respond in time/);
			assert.deepEqual(await folderLeft(w, "pending-launches", ".pending"), [], "a window that opens later must not start a launch nobody waits for");
		});

		it("tells the user when the new window took the launch but could not be brought to the front", async () => {
			const repo = await repoWith("repo-unfocused", "omp-vscode");
			const unity = path.join(repo, "omp-vscode");
			const w = await world([]);
			const watch = startPendingLaunchWatch(w.storageDir, "holder-new", () => [pendingKeyOf(unity)], async () => ({ ok: true, focused: false }), { debounceMs: 10 });
			cleanups.push(() => watch.dispose());
			assert.equal(await hand(w, { path: repo }, undefined, launch), true);
			assert.match(w.informed[0] ?? "", /did not bring it to the front/);
		});

		it("asks which of several projects once, remembers the answer for the folder, and starts nothing when dismissed", async () => {
			const repo = await repoWith("repo-two", "Alpha", "Beta");
			const beta = path.join(repo, "Beta");
			const memory = new Map<string, unknown>();
			const w = await world([{ holderId: "holder-beta", uri: URI.file(beta).toString(), serve: { ok: true, focused: true } }]);
			w.state.unityStore = { get: key => memory.get(key), update: async (key, value) => { memory.set(key, value); } };
			w.state.opening = opening({ [beta]: [there("holder-beta")] });
			const asked: unknown[] = [];
			let answer: "beta" | undefined;
			stub.window.showQuickPick = async rows => {
				asked.push(rows);
				return answer === undefined ? undefined : (rows as Array<{ candidate: string }>).find(item => item.candidate === beta);
			};
			assert.equal(await hand(w, { path: repo }, undefined, launch), true, "dismissing the question starts nothing anywhere");
			assert.equal(asked.length, 1);
			assert.deepEqual([w.served, w.calls], [[], []]);
			answer = "beta";
			assert.equal(await hand(w, { path: repo }, undefined, launch), true);
			assert.equal(asked.length, 2);
			assert.equal(w.served.length, 1, "the chosen project's window got the launch");
			assert.equal(await hand(w, { path: repo }, undefined, launch), true);
			assert.equal(asked.length, 2, "the answer is remembered for the folder");
			assert.equal(w.served.length, 2);
		});

		it("starts here, opening no second window, when the only window with the project runs an older build", async () => {
			const repo = await repoWith("repo-old", "omp-vscode");
			const unity = path.join(repo, "omp-vscode");
			const w = await world([{ holderId: "holder-old-u", uri: URI.file(unity).toString(), serve: { ok: true, focused: true } }]);
			w.state.opening = opening({ [unity]: [{ holderId: "holder-old-u", here: false, startedAt: STAMP, focusedAt: null, stale: true }] });
			assert.equal(await hand(w, { path: repo }, undefined, launch), false);
			assert.deepEqual([w.served, w.calls], [[], []], "no request, no new window, nothing brought forward");
			assert.match(w.informed[0] ?? "", /runs an older OMP Desk build/);
		});

		it("starts here when a window that claimed the pending launch refuses it as an older build", async () => {
			const repo = await repoWith("repo-old-pending", "omp-vscode");
			const unity = path.join(repo, "omp-vscode");
			const w = await world([]);
			w.state.opening = opening({ [repo]: [here] });
			const watch = startPendingLaunchWatch(w.storageDir, "holder-late-old", () => [pendingKeyOf(unity)], async () => ({ ok: false, focused: false, refusal: "stale-build" }), { debounceMs: 10 });
			cleanups.push(() => watch.dispose());
			assert.equal(await hand(w, { path: repo }, undefined, launch), false);
			assert.match(w.informed[0] ?? "", /runs an older OMP Desk build/);
			assert.deepEqual(w.warnings, []);
		});

		it("treats a folder without a Unity project like any other", async () => {
			const plain = path.join(unityRoot, "plain");
			await mkdir(path.join(plain, "src"), { recursive: true });
			const w = await world([{ holderId: "holder-b", uri: URI.file(plain).toString(), serve: { ok: true, focused: true } }]);
			w.state.opening = opening({ [plain]: [there("holder-b")] });
			assert.equal(await hand(w, { path: plain }), true);
			const served = w.served[0]!;
			assert.deepEqual(served.kind === "launch" ? served.workspace : null, { path: plain, match: "folder" });
		});
	});
});

describe("serving a launch another window asked for", () => {
	const serve = (w: World, launchRequest: LaunchRequest, context: ServeContext = wanted) => w.routing.serveLaunchRequest(undefined as never, w.index, launchRequest, context);
	const ready = (w: World, ...rows: FolderRow[]) => {
		w.state.folders = rows;
		w.state.opening = () => [here];
	};

	it("starts the launch here through the ordinary path, and answers on admission", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true, openElsewhere: false }));
		assert.deepEqual(await serve(w, request(newSession)), { ok: true, focused: true });
		await nextTurn(); await nextTurn();
		assert.deepEqual(w.drafts, [{ cwd: FOLDER }], "the same draft a click here makes");
	});

	it("resumes from the folder's history without changing a view that is live, and reports a failed start here", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true }));
		assert.deepEqual(await serve(w, request({ kind: "resume-folder", folderId: "folder:proj-1" })), { ok: true, focused: true });
		await nextTurn();
		assert.deepEqual(w.resumed, [{ cwd: FOLDER, keepLiveView: true }]);
		const failing = await world();
		ready(failing, folderRow({ openHere: true }));
		failing.deps.startNewSession = async () => { throw new Error("fixture draft"); };
		const failed = registerWindowRouting(failing.deps);
		await failed.serveLaunchRequest(undefined as never, failing.index, request(newSession), wanted);
		await nextTurn(); await nextTurn();
		assert.deepEqual(failing.errors, ["The session another window asked for could not be started: fixture draft"]);
	});

	it("opens a session through the ordinary open, in the view asked for only while it is not live here", async () => {
		const TAB = "tab:99999999-1111-4222-8333-444444444444";
		const w = await world();
		ready(w, folderRow({ openHere: true }));
		w.state.entries.set(TAB, { tabId: TAB, cwd: FOLDER, ownership: null, host: null });
		await serve(w, request({ kind: "open-session", tabId: TAB, verb: "resumed", mode: null }));
		await serve(w, request({ kind: "open-session", tabId: TAB, verb: "resumed", mode: "chat" }));
		w.state.liveFacts.set(TAB, { open: true, running: true, outcome: null, activity: null });
		await serve(w, request({ kind: "open-session", tabId: TAB, verb: "resumed", mode: "chat" }));
		await nextTurn();
		assert.deepEqual(w.opened, [
			["open-session", TAB, "resumed", true, true, "row"],
			["open-session-in-mode", TAB, "chat", "open", true, true],
			["open-session", TAB, "resumed", true, true, "row"],
		], "never routed again, and a session that is live here is only revealed");
	});

	it("refuses a request whose folder or session does not stand under the workspace it names, though this window has both", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true }), folderRow({ id: "folder:other-1", path: "C:/omp-vscode/other", openHere: true }));
		assert.deepEqual(await serve(w, request({ kind: "new-session", folderId: "folder:other-1" })), refused, "another folder this window shows is not the workspace the request names");
		assert.deepEqual(await serve(w, request({ kind: "resume-folder", folderId: "folder:other-1" }, { path: FOLDER, match: "root" })), refused, "and no folder stands under a root that is not a Unity project it holds");
		w.state.entries.set("tab:x", { tabId: "tab:x", cwd: "C:/omp-vscode/other", ownership: null, host: null });
		assert.deepEqual(await serve(w, request({ kind: "open-session", tabId: "tab:x", verb: "resumed", mode: null })), refused, "nor a session of another folder");
		await nextTurn();
		assert.deepEqual(w.drafts, []);
	});

	it("looks again at this window after its last asynchronous step: a workspace or folder that went away meanwhile starts nothing", async () => {
		const w = await world();
		let open = true;
		w.state.folders = [folderRow({ openHere: true })];
		w.state.opening = () => open ? [here] : [];
		assert.deepEqual(await serve(w, request(newSession), { ...wanted, stillWanted: async () => { open = false; return true; } }), refused, "the workspace was closed while the requester was asked");
		const rows = [folderRow({ openHere: true })];
		w.state.folders = rows;
		w.state.opening = () => [here];
		assert.deepEqual(await serve(w, request(newSession), { ...wanted, stillWanted: async () => { rows.length = 0; return true; } }), refused, "the folder left Sessions while the requester was asked");
		await nextTurn();
		assert.deepEqual(w.drafts, []);
	});

	it("fences the target it validated: a session whose working directory changed, or a folder that moved, during admission starts nothing", async () => {
		const w = await world();
		const entry: HeldEntry = { tabId: "tab:x", cwd: FOLDER, ownership: null, host: null };
		w.state.entries.set("tab:x", entry);
		ready(w, folderRow({ openHere: true }));
		assert.deepEqual(await serve(w, request({ kind: "open-session", tabId: "tab:x", verb: "resumed", mode: null }), { ...wanted, stillWanted: async () => { entry.cwd = `${FOLDER}/elsewhere`; return true; } }), refused);
		const rows = [folderRow({ openHere: true })];
		w.state.folders = rows;
		assert.deepEqual(await serve(w, request(newSession), { ...wanted, stillWanted: async () => { rows[0] = folderRow({ openHere: true, path: "C:/omp-vscode/proj-moved" }); return true; } }), refused);
		await nextTurn();
		assert.deepEqual([w.drafts, w.opened], [[], []]);
	});

	it("reads the other windows' records before it decides, as a window that has just started has read none", async () => {
		const w = await world();
		w.state.opening = () => [here];
		let refreshed = 0;
		w.registry.refresh = async () => { refreshed++; w.state.folders = [folderRow({ openHere: true })]; return true; };
		assert.deepEqual(await serve(w, request(newSession)), { ok: true, focused: true });
		assert.equal(refreshed, 1);
		assert.equal(w.refreshedLauncher.length, 1, "what the registry read is shown");
		await nextTurn(); await nextTurn();
		assert.deepEqual(w.drafts, [{ cwd: FOLDER }]);
	});

	it("waits for a window that has just started to be ready, so a launch that arrives early is not refused", async () => {
		const w = await world();
		w.state.opening = () => [here];
		const order: string[] = [];
		const catalog = Promise.withResolvers<void>();
		w.state.catalogReady = async () => { await catalog.promise; order.push("catalog"); };
		w.state.sessionFolders = async () => {
			order.push("roots");
			w.state.folders = [folderRow({ openHere: true })];
		};
		const outcome = serve(w, request(newSession));
		await nextTurn(); await nextTurn();
		assert.deepEqual(order, [], "nothing is decided before the catalog is read");
		catalog.resolve();
		assert.deepEqual(await outcome, { ok: true, focused: true });
		assert.deepEqual(order, ["catalog", "roots"]);
		await nextTurn(); await nextTurn();
		assert.deepEqual(w.drafts, [{ cwd: FOLDER }]);
	});

	it("publishes this window's snapshot before it reads the others', so the requester can find it", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true }));
		const order: string[] = [];
		const setSnapshot = w.registry.setSnapshot, refresh = w.registry.refresh;
		w.registry.setSnapshot = snapshot => { order.push("published"); return setSnapshot(snapshot); };
		w.registry.refresh = async () => { order.push("refreshed"); return refresh(); };
		await serve(w, request(newSession));
		assert.deepEqual(order, ["published", "refreshed"]);
	});

	it("refuses what this window cannot do itself, and starts nothing", async () => {
		const w = await world();
		w.state.folders = [folderRow()];
		w.state.opening = opening({ [FOLDER]: [there("holder-b")] });
		assert.deepEqual(await serve(w, request(newSession)), refused, "this window does not have the folder open");
		ready(w, folderRow({ openHere: true }));
		assert.deepEqual(await serve(w, request({ kind: "new-session", folderId: "folder:unknown" })), refused, "a folder this window does not show");
		assert.deepEqual(await serve(w, request({ kind: "open-session", tabId: "tab:nobody", verb: "resumed", mode: null })), refused, "a session this window does not list");
		assert.deepEqual(await serve(w, request(newSession), { ...wanted, stillWanted: async () => false }), refused, "the requester stopped waiting");
		w.state.opening = (_folderPath, options) => options?.exact === true ? [] : [here];
		assert.deepEqual(await serve(w, request(newSession, { path: FOLDER, match: "root" })), refused, "a workspace root this window does not have, whatever session folder it shows");
		await nextTurn();
		assert.deepEqual([w.drafts, w.opened], [[], []]);
		assert.ok(w.lines.some(line => line.level === "warn" && line.message.startsWith("window request: refused a launch (new-session) for C:/omp-vscode/proj (folder): this window does not have the workspace open")));
	});

	it("refuses first, as definitely not started, when the installed package changed under this window", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true }));
		w.state.packageChanged = true;
		let readied = 0;
		w.state.catalogReady = async () => { readied++; };
		assert.deepEqual(await serve(w, request(newSession)), { ok: false, focused: false, refusal: "stale-build" });
		await nextTurn(); await nextTurn();
		assert.deepEqual([w.drafts, readied, w.state.published], [[], 0, []], "nothing was waited for and nothing began here");
	});

	it("answers unfocused when this window does not come to the front within the wait", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true }));
		stub.window.state.focused = false;
		try {
			const outcome = await serve(w, request(newSession));
			assert.deepEqual(outcome, { ok: true, focused: false });
			assert.deepEqual(w.drafts.length, 1);
		} finally { stub.window.state.focused = true; }
	});

	it("answers focused as soon as this window comes to the front, without waiting out the full wait", async () => {
		const w = await world();
		ready(w, folderRow({ openHere: true }));
		stub.window.state.focused = false;
		try {
			const startedAt = Date.now();
			const outcome = serve(w, request(newSession));
			// The launch begins in the same step in which this window starts waiting for the focus.
			while (w.drafts.length === 0) await nextTurn();
			stub.window.fireFocus(true);
			assert.deepEqual(await outcome, { ok: true, focused: true });
			assert.ok(Date.now() - startedAt < 1_000, "the answer did not wait out the 1.5 s the window is given to come forward");
		} finally { stub.window.state.focused = true; }
	});
});

describe("serving another window's Kill All request", () => {
	const rows = [{ slot: "s1", brokerId: "b", brokerGeneration: "g", childCreationTime: "t" }, { slot: "s2", brokerId: "b", brokerGeneration: "g", childCreationTime: "t" }] as never;
	const stopRequest = { kind: "stop", version: 1, id: "id-stop-1", to: "this-window", from: "holder-a", createdAt: STAMP, rows } as unknown as StopRequest;
	const asking = (w: World, from = "holder-a") => {
		w.registry.windows = () => [{ holderId: from, here: false }, { holderId: "this-window", here: true }];
	};

	it("answers every row unconfirmed while this window has not read its processes", async () => {
		const w = await world();
		const outcome = await w.routing.serveStopRequest(w.index, stopRequest, wanted);
		assert.equal(outcome.ok, true);
		assert.deepEqual(outcome.rows?.map(row => row.state), ["unconfirmed", "unconfirmed"]);
	});

	it("refuses every row when the asking window is not another open window of this profile", async () => {
		const w = await world();
		w.state.processes = { serveStopRequest: async () => { throw new Error("must not stop"); } };
		const outcome = await w.routing.serveStopRequest(w.index, stopRequest, wanted);
		assert.deepEqual(outcome.rows?.map(row => row.state), ["refused", "refused"]);
		asking(w, "this-window");
		w.registry.windows = () => [{ holderId: "this-window", here: false }];
		const itself = await w.routing.serveStopRequest(w.index, { ...stopRequest, from: "this-window" } as StopRequest, wanted);
		assert.deepEqual(itself.rows?.map(row => row.state), ["refused", "refused"], "a request from itself is not another window's");
	});

	it("stops nothing for a requester that no longer waits", async () => {
		const w = await world();
		w.state.processes = { serveStopRequest: async () => { throw new Error("must not stop"); } };
		asking(w);
		const outcome = await w.routing.serveStopRequest(w.index, stopRequest, { ...wanted, stillWanted: async () => false });
		assert.deepEqual(outcome.rows?.map(row => row.state), ["unconfirmed", "unconfirmed"]);
	});

	it("reads the other windows afresh and has this window's own processes answer per row, reporting progress", async () => {
		const w = await world();
		asking(w);
		const progress: number[] = [];
		w.state.processes = {
			serveStopRequest: async (named, report) => {
				await report(1);
				return named.map(() => ({ state: "stopped", reason: "" }));
			},
		};
		const outcome = await w.routing.serveStopRequest(w.index, stopRequest, { ...wanted, progress: async done => { progress.push(done); } });
		assert.deepEqual(outcome, { ok: true, focused: false, rows: [{ state: "stopped", reason: "" }, { state: "stopped", reason: "" }] });
		assert.deepEqual(progress, [1]);
		assert.equal(w.state.refreshes, 1);
		assert.ok(w.logged.includes("stop request id-stop- from window holder-a: 2 row(s)"));
	});

	it("still answers when the other windows could not be read", async () => {
		const w = await world();
		asking(w);
		w.registry.refresh = async () => { throw new Error("locked"); };
		w.state.processes = { serveStopRequest: async named => named.map(() => ({ state: "stopped", reason: "" })) };
		const outcome = await w.routing.serveStopRequest(w.index, stopRequest, wanted);
		assert.deepEqual(outcome.rows?.map(row => row.state), ["stopped", "stopped"]);
		assert.ok(w.logged.includes("stop request: the other windows could not be read: locked"));
	});
});

describe("serving another window's request to select a session's tab", () => {
	const tabFor = (n: number) => `tab:88888888-2222-4333-8444-55555555555${n}`;
	const MADE = "2026-10-10T10:00:00.000Z";
	const ours = { verifiable: true, holderId: "this-window", pid: 4242, ownerGeneration: OWNER, windowUri: null };
	const elsewhere = { ...ours, holderId: "another-window" };
	const earlierRun = { ...ours, ownerGeneration: "a-generation-this-window-does-not-record" };

	/** A session this window holds, whose editor VS Code restored but has not shown yet. */
	async function setup(n: number) {
		const w = await world();
		const slot = String(n).repeat(32);
		const tabId = tabFor(n);
		const entry: HeldEntry = { tabId, cwd: FOLDER, ownership: { ownerGeneration: OWNER }, host: { startedAt: STAMP, pid: 930 + n } };
		w.state.entries.set(tabId, entry);
		w.state.tabs.set(tabId, { slotId: slot, panel: null });
		w.state.editorTabs.add(slot);
		w.state.binding = { tabId, role: "controlling", mode: "chat", generation: 3 };
		w.state.claim = ours;
		const select = { version: 1, id: "id-1", to: "this-window", from: "other", kind: "select", tabId, incarnation: sessionIncarnation(entry)!, binding: `${slot}.3`, createdAt: MADE } as SwitchRequest;
		return { w, slot, tabId, select, serveIt: (override: Partial<SwitchRequest> = {}, context: ServeContext = wanted) => w.routing.selectHeldTab(w.index, { ...select, ...override }, context) };
	}

	it("selects the editor it already has and requests nothing else", async () => {
		const { w, slot, serveIt } = await setup(1);
		assert.deepEqual(await serveIt(), { ok: true, focused: true });
		assert.deepEqual(w.selected, [slot], "the tab is selected; no open, restore, launch or mode change is requested");
		assert.deepEqual([w.opened, w.openedTabs, w.revealed], [[], [], []]);
	});

	it("reveals the panel it holds instead of selecting a tab", async () => {
		const { w, tabId, serveIt } = await setup(1);
		w.state.tabs.set(tabId, { slotId: "1".repeat(32), panel: {} });
		assert.deepEqual(await serveIt(), { ok: true, focused: true });
		assert.deepEqual([w.revealed, w.selected, [...w.requestSelections]], [[tabId], [], []]);
	});

	it("answers that this window is not in front when it does not come to the front within the wait", async () => {
		const { serveIt } = await setup(1);
		stub.window.state.focused = false;
		try {
			assert.deepEqual(await serveIt(), { ok: true, focused: false });
		} finally { stub.window.state.focused = true; }
	});

	it("refuses, selecting nothing, when this window records another run than the request names", async () => {
		const { w, serveIt } = await setup(2);
		assert.deepEqual(await serveIt({ incarnation: `${OWNER}_an-earlier-launch` }), refused);
		assert.deepEqual(w.selected, []);
	});

	it("refuses, selecting nothing, when the claim is not this window's or is of another generation, or when the requester gave up", async () => {
		const { w, serveIt } = await setup(3);
		w.state.claim = elsewhere;
		assert.deepEqual(await serveIt(), refused);
		w.state.claim = earlierRun;
		assert.deepEqual(await serveIt(), refused, "the claim names this window but not the generation the catalog records");
		w.state.claim = null;
		assert.deepEqual(await serveIt(), refused, "no claim at all");
		w.state.claim = ours;
		assert.deepEqual(await serveIt({}, { ...wanted, stillWanted: async () => false }), refused);
		assert.deepEqual(w.selected, []);
	});

	it("refuses, selecting nothing, for a session it has no editor for, and when it has no live host to serve it", async () => {
		const { w, serveIt } = await setup(4);
		assert.deepEqual(await serveIt({ tabId: tabFor(5) }), refused);
		w.state.liveHost = false;
		assert.deepEqual(await serveIt(), refused, "showing a not-yet-revived editor could otherwise start a restore of a session nothing serves");
		w.state.liveHost = true;
		w.state.editorTabs.clear();
		assert.deepEqual(await serveIt(), refused, "VS Code shows no tab for the editor: nothing can be revived, so no command is issued and no mark is left");
		assert.deepEqual([w.selected, [...w.requestSelections]], [[], []]);
	});

	it("refuses a request that names another binding of the editor than the one now serving the session (a native handover and back)", async () => {
		const { w, serveIt } = await setup(6);
		w.state.binding.generation = 4;
		assert.deepEqual(await serveIt(), refused);
		assert.deepEqual(w.selected, []);
		assert.deepEqual(await serveIt({ binding: null }), { ok: true, focused: true }, "a request that saw no published binding is fenced by the run alone");
	});

	it("refuses a request that names the binding of another editor slot of the same run", async () => {
		const { w, serveIt } = await setup(0);
		assert.deepEqual(await serveIt({ binding: `${"f".repeat(32)}.3` }), refused);
		assert.deepEqual(w.selected, []);
	});

	it("does not select for a requester that gave up while the claim was being read", async () => {
		const { w, serveIt } = await setup(9);
		let release!: () => void;
		const stalled = new Promise<void>(resolve => { release = resolve; });
		let wantedNow = true;
		w.fake.observeOwnership = async () => { await stalled; return { ok: true, claim: ours }; };
		const pending = serveIt({}, { ...wanted, stillWanted: async () => wantedNow });
		wantedNow = false;
		release();
		assert.deepEqual(await pending, refused);
		assert.deepEqual(w.selected, []);
	});

	it("does not report success when the claim or the binding changed while it selected", async () => {
		const claimMoved = await setup(7);
		let reads = 0;
		claimMoved.w.fake.observeOwnership = async () => ({ ok: true, claim: ++reads === 1 ? ours : elsewhere });
		assert.deepEqual(await claimMoved.serveIt(), refused);
		const rebound = await setup(8);
		let looks = 2;
		rebound.w.fake.slotBinding = () => ({ ...rebound.w.state.binding, generation: ++looks });
		assert.deepEqual(await rebound.serveIt({ binding: null }), refused);
	});

	it("defers the serializer's restore of a tab it is showing, however late VS Code revives the editor, and only once", async () => {
		const { w, tabId, serveIt } = await setup(5);
		assert.deepEqual(await serveIt(), { ok: true, focused: true });
		assert.ok(w.requestSelections.has(tabId), "the tab is marked until its editor is revived");
		// Nothing releases the mark on time: the serializer reaches the helper long after the request was answered.
		await nextTurn(); await nextTurn();
		assert.ok(w.requestSelections.has(tabId));
		w.state.liveHost = false;
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, tabId);
		assert.deepEqual([w.openedTabs, w.elected], [[], []], "nothing was opened, restored or claimed");
		assert.equal(w.requestSelections.has(tabId), false, "the revival consumed the mark");
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, tabId);
		assert.equal(w.openedTabs.length, 1, "a second revival is an ordinary restore");
	});

	it("keeps the serializer deferral even when the selection did not end with the tab active", async () => {
		const { w, tabId, serveIt } = await setup(1);
		w.state.selectResult = false;
		assert.deepEqual(await serveIt(), refused);
		assert.ok(w.requestSelections.has(tabId), "a command may already have triggered the revival");
		w.state.liveHost = false;
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, tabId);
		assert.deepEqual(w.openedTabs, []);
	});
});

describe("opening an editor VS Code restored", () => {
	const TAB = "tab:77777777-2222-4333-8444-555555555555";
	const entry: HeldEntry = { tabId: TAB, cwd: FOLDER, ownership: null, host: null };

	it("only elects its controller when this window already runs the session, and consumes the mark", async () => {
		const w = await world();
		w.state.entries.set(TAB, entry);
		w.requestSelections.add(TAB);
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, TAB);
		assert.deepEqual([w.elected, w.openedTabs, [...w.requestSelections]], [[TAB], [], []]);
	});

	it("leaves a tab the activation pass covers to that pass, and opens any other", async () => {
		const w = await world();
		w.state.entries.set(TAB, entry);
		w.state.liveHost = false;
		w.state.startupCovers = true;
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, TAB);
		assert.deepEqual(w.openedTabs, []);
		w.state.startupCovers = false;
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, TAB);
		assert.deepEqual(w.openedTabs, [[TAB, "opened", "restored"]]);
	});

	it("does nothing for a tab the index does not list", async () => {
		const w = await world();
		await w.routing.openRestoredTabIfUncovered(undefined as never, w.index, TAB);
		assert.deepEqual([w.elected, w.openedTabs], [[], []]);
	});

	it("forgets another window's request to show a tab when the user opens it explicitly", async () => {
		const w = await world();
		w.requestSelections.add(TAB);
		assert.equal(w.routing.consumeRequestedSelection(TAB), true);
		assert.equal(w.routing.consumeRequestedSelection(TAB), false);
	});
});

describe("watching for requests", () => {
	it("serves a request addressed to this window from the request directory, and a launch left for a folder it has open", async () => {
		const w = await world();
		const TAB = "tab:66666666-2222-4333-8444-555555555555";
		const entry: HeldEntry = { tabId: TAB, cwd: FOLDER, ownership: { ownerGeneration: OWNER }, host: { startedAt: STAMP, pid: 12 } };
		w.state.entries.set(TAB, entry);
		w.state.tabs.set(TAB, { slotId: "6".repeat(32), panel: null });
		w.state.editorTabs.add("6".repeat(32));
		w.state.binding = { tabId: TAB, role: "controlling", mode: "chat", generation: 1 };
		w.state.claim = { verifiable: true, holderId: "this-window", pid: 4242, ownerGeneration: OWNER, windowUri: null };
		stub.workspace.workspaceFolders = [{ uri: URI.file(FOLDER) }];
		w.state.folders = [folderRow({ openHere: true })];
		w.state.opening = () => [here];
		w.routing.serveRequests(undefined as never, w.index, { identityKeyOf: (value: string) => value } as never);
		try {
			const posted = await postSwitchRequest(w.storageDir, { to: "this-window", from: "holder-a", tabId: TAB, incarnation: sessionIncarnation(entry)!, binding: `${"6".repeat(32)}.1` });
			assert.equal(await awaitRequestAnswer(w.storageDir, "this-window", posted, { timeoutMs: 3_000 }), "served");
			assert.deepEqual(w.selected, ["6".repeat(32)]);
			const pending = await postPendingLaunch(w.storageDir, { from: "holder-a", key: pendingKeyOf(URI.file(FOLDER).fsPath), workspace: { path: FOLDER, match: "folder" }, launch: newSession });
			assert.equal(await awaitPendingLaunchAnswer(w.storageDir, pending, { timeoutMs: 3_000 }), "served", "a window that has the folder open claims what was left for it");
			await nextTurn();
			assert.deepEqual(w.drafts, [{ cwd: FOLDER }]);
		} finally {
			w.routing.dispose();
			stub.workspace.workspaceFolders = undefined;
		}
	});

	it("serves nothing after it was disposed", async () => {
		const w = await world();
		w.routing.serveRequests(undefined as never, w.index, { identityKeyOf: (value: string) => value } as never);
		w.routing.dispose();
		w.routing.rescanRequests();
		w.routing.rescanPendingLaunches();
		const posted = await postSwitchRequest(w.storageDir, { to: "this-window", from: "holder-a", tabId: "tab:x", incarnation: "g_none", binding: null });
		assert.equal(await awaitRequestAnswer(w.storageDir, "this-window", posted, { timeoutMs: 300 }), "timeout");
	});
});

describe("telling every window that a credential changed", () => {
	const serving = (w: World) => w.routing.serveRequests(undefined as never, w.index, { identityKeyOf: (value: string) => value } as never);
	const settled = async (windows: readonly World[]) => { for (let turns = 0; turns < 5; turns++) { windows.forEach(w => w.routing.rescanRequests()); await nextTurn(); } };

	it("makes every other window of the profile re-read its models once, and not the window that announced", async () => {
		const sender = await world([{ holderId: "window-b", uri: null, serve: null }, { holderId: "window-c", uri: null, serve: null }], { holderId: "window-a" });
		const second = await world([], { holderId: "window-b", storageDir: sender.storageDir });
		const third = await world([], { holderId: "window-c", storageDir: sender.storageDir });
		const bystander = await world([], { holderId: "window-d", storageDir: sender.storageDir });
		for (const w of [second, third, bystander]) serving(w);
		try {
			await sender.routing.announceCredentialsChanged();
			assert.deepEqual([second.modelRefreshes.length, third.modelRefreshes.length], [1, 1], "each named window re-read once");
			assert.equal(bystander.modelRefreshes.length, 0, "a window the registry does not name is not asked");
			assert.equal(sender.modelRefreshes.length, 0, "the announcing window refreshes through its own path, not through a request");
			await settled([sender, second, third]);
			assert.deepEqual([second.modelRefreshes.length, third.modelRefreshes.length], [1, 1], "a request is acted on once");
			assert.deepEqual([await folderLeft(sender, "window-requests", ".request"), await folderLeft(sender, "window-requests", ".response")], [[], []], "nothing is left in the directory");
			assert.deepEqual(sender.errors, []);
			assert.equal(sender.calls.filter(call => call[0] === "workbench.action.reloadWindow").length, 0, "nothing reloads");
		} finally {
			for (const w of [second, third, bystander]) w.routing.dispose();
		}
	});

	it("does not echo a notice it received, and never throws for a window that stays silent", async () => {
		const sender = await world([{ holderId: "window-asleep", uri: null, serve: null }], { holderId: "window-a" });
		const started = Date.now();
		await sender.routing.announceCredentialsChanged();
		assert.ok(Date.now() - started < 8_000);
		assert.ok(sender.logged.some(line => line.includes("window-asleep") && line.includes("did not answer")));
		assert.deepEqual(await folderLeft(sender, "window-requests", ".request"), [], "the unanswered request is withdrawn");
		const receiver = await world([{ holderId: "window-a", uri: null, serve: null }], { holderId: "window-b", storageDir: sender.storageDir });
		serving(receiver);
		try {
			const id = await postModelsRequest(sender.storageDir, { to: "window-b", from: "window-a" });
			assert.equal(await awaitRequestAnswer(sender.storageDir, "window-b", id, { timeoutMs: 3_000 }), "unfocused", "answered");
			await settled([receiver]);
			assert.equal(receiver.modelRefreshes.length, 1);
			assert.deepEqual(await folderLeft(receiver, "window-requests", ".request"), [], "the receiver posted nothing onward");
		} finally {
			receiver.routing.dispose();
		}
	});

	it("does nothing without a session index", async () => {
		const w = await world([{ holderId: "window-b", uri: null, serve: null }]);
		w.deps.index = () => null;
		await w.routing.announceCredentialsChanged();
		assert.deepEqual(await readdir(path.join(w.storageDir)).catch(() => []), []);
	});
});

describe("reloading every window", () => {
	const RELOAD = "workbench.action.reloadWindow";
	const reloadsOf = (w: World) => w.calls.filter(call => call[0] === RELOAD).length;
	const takenUp: ServeOutcome = { ok: true, focused: false };
	const asked = (w: World) => w.served.filter(request => request.kind === "reload");
	after(() => { stub.commands.handler = null; });

	/** What `served` held when this window ran its own reload: the peers must have been asked first. */
	function recordReloadMoment(w: World): number[] {
		const moments: number[] = [];
		stub.commands.handler = command => { if (command === RELOAD) moments.push(asked(w).length); };
		return moments;
	}

	it("asks every other window to reload, then reloads this window once", async () => {
		const w = await world([{ holderId: "holder-b", uri: null, serve: takenUp }, { holderId: "holder-c", uri: null, serve: takenUp }]);
		const moments = recordReloadMoment(w);
		await w.routing.reloadAllWindows();
		assert.deepEqual(asked(w).map(request => [request.to, request.from]).sort(), [["holder-b", "this-window"], ["holder-c", "this-window"]], "each peer, and only the peers, got a request from this window");
		assert.equal(reloadsOf(w), 1);
		assert.deepEqual(moments, [2], "this window reloaded after both requests had been taken up");
		assert.equal(w.state.refreshes > 0, true, "the other windows were read afresh first");
		assert.equal(w.logged.filter(line => line.includes("is reloading")).length, 2);
		assert.deepEqual(w.errors, []);
	});

	it("reloads this window after posting even when a peer never takes the request up, and withdraws the request", async () => {
		const w = await world([{ holderId: "holder-b", uri: null, serve: takenUp }, { holderId: "holder-asleep", uri: null, serve: null }]);
		const started = Date.now();
		await w.routing.reloadAllWindows(100);
		assert.equal(reloadsOf(w), 1);
		assert.deepEqual(asked(w).map(request => request.to), ["holder-b"]);
		assert.deepEqual(await folderLeft(w, "window-requests", ".request"), [], "the request nobody took up is withdrawn, so that window never reloads late");
		assert.ok(w.lines.some(line => line.level === "warn" && line.message.includes("holder-asleep") && line.message.includes("did not take the request up")), "the silent peer is logged");
		assert.ok(Date.now() - started < 1_500, "bounded by the wait for a window");
	});

	it("does not wait for a window that deletes the request unanswered (an older build), and says so", async () => {
		const w = await world([{ holderId: "holder-old", uri: null, serve: null }]);
		const deleting = (async () => {
			const directory = path.join(w.storageDir, "window-requests");
			for (;;) {
				const names = await readdir(directory).catch(() => [] as string[]);
				const posted = names.find(name => name.startsWith("holder-old.") && name.endsWith(".request"));
				if (posted !== undefined) { await rm(path.join(directory, posted)); return; }
				await nextTurn();
			}
		})();
		await w.routing.reloadAllWindows(30_000);
		await deleting;
		assert.equal(reloadsOf(w), 1);
		assert.ok(w.logged.some(line => line.includes("holder-old") && line.includes("older build")));
	});

	it("reloads only this window when no other window is open or the session index is not ready", async () => {
		const alone = await world();
		await alone.routing.reloadAllWindows();
		assert.equal(reloadsOf(alone), 1);
		assert.deepEqual(alone.served, []);
		const starting = await world([{ holderId: "holder-b", uri: null, serve: takenUp }]);
		starting.deps.index = () => null;
		await starting.routing.reloadAllWindows();
		assert.equal(reloadsOf(starting), 1);
		assert.deepEqual(starting.served, [], "nobody could be addressed without the index");
	});

	it("still reloads this window when the other windows cannot be read, and tells the user when its own reload fails", async () => {
		const w = await world([{ holderId: "holder-b", uri: null, serve: takenUp }]);
		w.registry.refresh = async () => { throw new Error("locked"); };
		await w.routing.reloadAllWindows();
		assert.equal(reloadsOf(w), 1);
		assert.equal(asked(w).length, 1, "the windows it already knew were still asked");
		stub.commands.handler = () => { throw new Error("no reload today"); };
		await w.routing.reloadAllWindows();
		assert.deepEqual(w.errors, ["This window could not be reloaded: no reload today"]);
	});

	it("joins a reload already under way instead of asking the windows twice", async () => {
		const w = await world([{ holderId: "holder-b", uri: null, serve: takenUp }]);
		await Promise.all([w.routing.reloadAllWindows(), w.routing.reloadAllWindows()]);
		assert.deepEqual([asked(w).length, reloadsOf(w)], [1, 1]);
	});

	describe("when another window asks this one", () => {
		const serving = async () => {
			const w = await world();
			const reloaded = Promise.withResolvers<void>();
			stub.commands.handler = command => { if (command === RELOAD) reloaded.resolve(); };
			w.routing.serveRequests(undefined as never, w.index, { identityKeyOf: (value: string) => value } as never);
			return { w, reloaded: reloaded.promise };
		};

		it("reloads this window exactly once, after answering, and leaves nothing for the restarted window to act on", async () => {
			const { w, reloaded } = await serving();
			try {
				const id = await postReloadRequest(w.storageDir, { to: "this-window", from: "holder-a" });
				assert.equal(await awaitReloadTakenUp(w.storageDir, "this-window", id, { timeoutMs: 3_000 }), "taken-up");
				await reloaded;
				w.routing.rescanRequests();
				await nextTurn(); await nextTurn();
				assert.equal(reloadsOf(w), 1);
				assert.deepEqual([await folderLeft(w, "window-requests", ".request"), await folderLeft(w, "window-requests", ".accepted")], [[], []]);
			} finally {
				w.routing.dispose();
			}
		});

		it("does not reload for a request older than its lifetime", async () => {
			const { w } = await serving();
			try {
				const id = await postReloadRequest(w.storageDir, { to: "this-window", from: "holder-a" }, () => Date.now() - 60_000);
				// The window deletes what it will not act on; that is how the requester sees it gone.
				assert.equal(await awaitReloadTakenUp(w.storageDir, "this-window", id, { timeoutMs: 3_000 }), "unanswered");
				w.routing.rescanRequests();
				await nextTurn(); await nextTurn();
				assert.equal(reloadsOf(w), 0);
			} finally {
				w.routing.dispose();
			}
		});
	});
});

describe("the file window", () => {
	const fileTab = (group: StubTabGroup, label: string) => ({ label, input: new stub.TabInputText(URI.file(`C:/work/${label}`)), group });
	const groupOf = (viewColumn: number, ...labels: string[]): StubTabGroup => {
		const group: StubTabGroup = { viewColumn, tabs: [], activeTab: undefined };
		group.tabs = labels.map(label => fileTab(group, label));
		group.activeTab = group.tabs[0];
		return group;
	};

	it("says so when no file is open next to the chat", async () => {
		const w = await world();
		const chat = { viewColumn: 1, tabs: [{ label: "chat", input: { session: true }, group: undefined as never }], activeTab: undefined } as StubTabGroup;
		stub.window.tabGroups.all = [chat];
		stub.window.tabGroups.activeTabGroup = chat;
		await w.routing.moveFileToNewWindow();
		assert.deepEqual(w.informed, ["No file is open next to the chat."]);
		assert.equal(w.routing.fileWindowColumn(), undefined, "no file window: VS Code chooses");
	});

	it("opens the files group in a window of its own through VS Code's size-taking command, keeps it on top, and remembers it", async () => {
		const w = await world();
		const chat = { viewColumn: 1, tabs: [{ label: "chat", input: { session: true }, group: undefined as never }], activeTab: undefined } as StubTabGroup;
		const files = groupOf(2, "a.ts", "b.ts");
		stub.window.tabGroups.all = [chat, files];
		stub.window.tabGroups.activeTabGroup = files;
		const auxiliary = groupOf(3);
		stub.commands.handler = (command: unknown) => {
			if (command === "_workbench.open") stub.window.tabGroups.all = [chat, files, auxiliary];
			return undefined;
		};
		try {
			await w.routing.moveFileToNewWindow();
			const commands = w.calls.map(call => call[0]);
			assert.equal(commands[0], "_workbench.open");
			assert.equal((w.calls[0]?.[2] as unknown[])[0], -3, "the auxiliary window target");
			assert.ok(commands.includes("workbench.action.enableWindowAlwaysOnTop"));
			assert.equal(w.routing.fileWindowColumn(), 3, "files from the chat open in the file window while it lasts");
		} finally {
			stub.commands.handler = null;
			stub.window.tabGroups.all = [];
		}
	});
});
