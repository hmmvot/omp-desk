/**
 * The Sessions view's session actions through their interface with fake dependencies: what a click, a go-to, a
 * forget, a stop, a kill, a deletion and a refresh ask of the user, of the session index and of the window, and
 * what they leave behind.
 *
 * The cases that need a session index use the real `SessionIndex` over an in-memory store and a temporary claim
 * directory, with the ownership reconciler's ports and the broker stop port faked; everything of the window (tab
 * records, launcher, broker slots, dialogs) is a fake the cases set. `vscode` is the stand-in of
 * `vscode-test-stub.ts`, so this file must run under `node --test`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import module from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import type { BrokerSlotProvenance, BrokerSlotStore } from "../host/broker-slots.ts";
import type { SessionHostRuntime } from "../host/native-session.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { OwnerReconciler, RecordedHostStopPort } from "../host/session-availability.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import { LocalSessionRuntime } from "../runtime/local-runtime.ts";
import type { SessionActionsDeps, SessionTab } from "./session-actions.ts";

// The module and the views it imports load the `vscode` specifier; map it before the first import.
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
const { createRecordedHostStopPort, readBrokerProvenance, registerSessionActions } = await import("./session-actions.ts");
const { ProcessTreeItem } = await import("../views/process-rows.ts");
const { SessionTreeItem } = await import("../views/session-tree.ts");
const { createOwnerReconciler } = await import("../host/rpc-reconcile.ts");
const { acquireClaim, createClaimHolder } = await import("../host/session-claim.ts");
const { SessionIndex: SessionIndexClass } = await import("../host/session-index.ts");

const TAB = "tab:11111111-2222-4333-8444-555555555555";
const OTHER_TAB = "tab:99999999-2222-4333-8444-555555555555";
const OWNER = "owner-test";
const SLOT = "host:legacy-fixture";
const STAMP = "2026-09-29T10:25:25Z";
const STOP_LABEL = "Stop OMP Process";

let temp: string;
before(async () => { temp = await mkdtemp(path.join(tmpdir(), "omp-session-actions-")); });
after(async () => { await rm(temp, { recursive: true, force: true }); });

/** A row of the session tree as the actions read it: `instanceof` is all the module checks of the class. */
const sessionRow = (tabId: string, state: string): InstanceType<typeof SessionTreeItem> =>
	Object.assign(Object.create(SessionTreeItem.prototype), { tabId, state, headline: `Session ${tabId}`, description: "idle", iconPath: undefined });
const processRow = (overrides: Record<string, unknown>, openTarget: string | null): InstanceType<typeof ProcessTreeItem> =>
	Object.assign(Object.create(ProcessTreeItem.prototype), { row: { id: "row-1", slot: "slot-1", host: null, window: "this-window", ...overrides }, openTarget });

const tabRecord = (slotId: string, tabId: string | null, overrides: Partial<SessionTab> = {}): SessionTab =>
	({ slotId, tabId, panel: null, runtime: null, transitioning: false, nativeWatch: null, ownerStopWatch: null, ...overrides });

interface Dialog { readonly message: string; readonly detail: string | undefined; readonly modal: boolean; readonly items: readonly string[] }

/** Everything the actions of one fake window did, and the records the cases set. */
async function world(index: unknown = null, overrides: Partial<SessionActionsDeps<SessionTab>> = {}) {
	const state = {
		tabs: new Map<string, SessionTab>(),
		outcomes: new Map<string, unknown>(),
		stopping: new Set<string>(),
		opening: new Map<string, Promise<void>>(),
		/** The button a modal dialog answers: `undefined` dismisses it, `"first"` presses its first button. */
		answer: "first" as "first" | undefined,
		provenance: { kind: "slot", slot: SLOT } as BrokerSlotProvenance,
		stopPort: null as RecordedHostStopPort | null,
		reconciler: { reconcile: async () => ({ kind: "free", evidence: [] }) } as unknown as OwnerReconciler,
		context: { globalStorageUri: { fsPath: temp }, subscriptions: [] } as never,
		brokerSlots: undefined as BrokerSlotStore | undefined,
		folders: undefined as unknown,
		provider: undefined as unknown,
		view: undefined as { message?: string; visible: boolean } | undefined,
		processes: null as { refresh(): Promise<{ rows: unknown[] }>; sync(): void; touch(): void; serveStopRequest(): Promise<never[]> } | null,
		registry: undefined as { readOtherWindows(): Promise<{ unreadable: number; windows: unknown[] }> } | undefined,
		shellSlots: undefined as { get(slot: string): unknown } | undefined,
		shellEditors: new Set<string>(),
		picked: undefined as ((items: { label: string }[]) => unknown) | undefined,
		facts: new Map<string, Record<string, unknown>>(),
		deadline: async <T>(read: Promise<T>): Promise<T> => await read,
		transition: async () => null as unknown,
		/** Runs inside a dialog, before its answer: what must already hold when the user is asked. */
		beforeAnswer: undefined as (() => Promise<void>) | undefined,
	};
	const dialogs: Dialog[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	const errors: string[] = [];
	const logged: string[] = [];
	const opened: unknown[][] = [];
	const refreshes: unknown[] = [];
	const released: unknown[][] = [];
	const forgotten: string[] = [];
	const editorsReleased: string[] = [];
	const slotsRemoved: string[] = [];
	const conversationsClosed: string[] = [];
	const stopPortRequests: unknown[][] = [];
	const confirmedStops: unknown[][] = [];
	const catalogAdoptions: unknown[][] = [];
	/** What the window was asked, in order, across ports whose relative order a case asserts. */
	const order: string[] = [];
	const reattached: unknown[][] = [];
	const shellsAttached: unknown[] = [];
	const tabsAsked: string[] = [];
	const deps: SessionActionsDeps<SessionTab> = {
		context: () => state.context,
		reconciler: () => state.reconciler,
		brokerSlots: () => state.brokerSlots,
		shellSlots: () => state.shellSlots as never,
		launcherFolders: () => state.folders as never,
		outcomes: () => state.outcomes as never,
		openingTab: tabId => { tabsAsked.push(tabId); return state.opening.get(tabId); },
		hasShellEditor: slot => state.shellEditors.has(slot),
		stoppingTabs: () => state.stopping,
		routing: () => ({ registry: () => state.registry as never }),
		sessionProcesses: () => state.processes as never,
		setSessionProcesses: processes => { state.processes = processes as never; },
		catalogLoaded: () => true,
		tab: key => key === null ? undefined : state.tabs.get(key) ?? [...state.tabs.values()].find(candidate => candidate.tabId === key),
		tabs: () => state.tabs,
		detailTabs: () => ({ closeConversation: tabId => { conversationsClosed.push(tabId); } }),
		editorSlots: () => ({ remove: (slot: string) => { slotsRemoved.push(slot); } }) as never,
		bridgeEditors: () => ({ releaseEditor: slot => { editorsReleased.push(slot); return true; } }),
		passiveReasonForSlot: () => null,
		launcherProvider: () => state.provider as never,
		launcherView: () => state.view as never,
		refreshLauncher: options => { order.push("refresh"); refreshes.push(options); },
		facts: tabId => (state.facts.get(tabId) ?? { open: false, running: false, outcome: null, activity: null }) as never,
		sessionsGrouping: () => "flat",
		openSession: async (...args) => { opened.push(args.slice(2)); return true; },
		attachFolderShell: async (...args) => { shellsAttached.push(args[2]); return true; },
		tabIdArgument: argument => {
			if (typeof argument === "string" && argument.length > 0) return argument;
			return typeof argument === "object" && argument !== null && "tabId" in argument && typeof argument.tabId === "string" ? argument.tabId : null;
		},
		pickIndexedTab: async () => null,
		sessionTarget: (target, argument) => {
			const tabId = typeof argument === "string" ? argument : null;
			const entry = tabId === null ? null : (target as SessionIndex).get(tabId);
			return tabId === null || entry === null ? null : { tabId, entry };
		},
		confirmAndStopRuntime: async (...args) => { confirmedStops.push(args.slice(2)); return true; },
		readTransitionFacts: async () => await state.transition() as never,
		withSessionReadDeadline: async read => await state.deadline(read),
		fenceSessionAdmission: (_index, tab, fenced) => { tab.transitioning = fenced; },
		pushSessionView: () => {},
		stopSessionRuntime: async () => ({ writerGone: true, treeEmpty: true, detail: "stopped" }),
		stopTerminalForTab: () => {},
		disposeControlChannel: () => {},
		retireBroker: async () => {},
		releaseHostControl: async (tabId, owner) => { released.push([tabId, owner]); },
		reconnectHostControl: async () => {},
		sessionRuntime: () => new LocalSessionRuntime({
			index: index as never,
			reconciler: () => state.reconciler,
			stop: { requestStop: async () => ({ writerGone: true, treeEmpty: true, detail: "fixture" }), confirmEnded: async () => null, awaitSettled: async () => null, readTransitionFacts: async () => null },
			control: {} as never, identity: {} as never, nativeWatch: {} as never, exit: {} as never,
			launcher: () => ({
				launch: async () => ({ state: "not-started", reason: "fixture" }),
				attach: async request => { reattached.push([request]); return { state: "unavailable", reason: "fixture" }; },
			}),
		}),
		recordedControlOwner: entry => entry.ownership?.ownerGeneration ?? null,
		controlOwnerFor: (_runtime, generation) => generation,
		forgetTurnActivity: (_index, tabId) => { forgotten.push(tabId); },
		brokerClient: async () => null,
		attachBrokerClient: async () => null,
		brokerProvenanceFor: () => state.provenance,
		recordedHostStopPort: (...args) => { stopPortRequests.push(args); return state.stopPort as RecordedHostStopPort; },
		ensureCatalogReady: async () => {},
		adoptCatalogChanges: async (...args) => { order.push("adopt"); catalogAdoptions.push(args.slice(1)); },
		showWarningMessage: async (message, options, ...items) => {
			dialogs.push({ message, detail: options.detail, modal: options.modal === true, items });
			await state.beforeAnswer?.();
			return state.answer === "first" ? items[0] : undefined;
		},
		showQuickPick: (async (items: { label: string }[]) => state.picked?.(items)) as never,
		log: message => { logged.push(message); },
		info: message => { infos.push(message); },
		warn: message => { warnings.push(message); },
		error: message => { errors.push(message); },
		...overrides,
	};
	const actions = registerSessionActions(deps);
	stub.commands.calls.length = 0;
	stub.commands.handler = null;
	stub.window.notices.length = 0;
	return {
		actions, deps, state, index: index as never, dialogs, warnings, infos, errors, logged, opened, refreshes, released, forgotten, editorsReleased, slotsRemoved,
		conversationsClosed, stopPortRequests, confirmedStops, catalogAdoptions, order, reattached, shellsAttached, tabsAsked, commands: stub.commands.calls, notices: stub.window.notices,
	};
}

/** A fake index for the cases that only read rows and call the few index methods the action under test uses. */
function fakeIndex(entries: readonly Partial<SessionIndexEntry>[] = [], extra: Record<string, unknown> = {}): SessionIndex {
	const rows = new Map(entries.map(entry => [entry.tabId as string, entry as SessionIndexEntry]));
	return {
		claimHolder: { id: "this-window-holder" },
		claimStorageDir: temp,
		loadError: null,
		get: (tabId: string) => rows.get(tabId) ?? null,
		list: () => [...rows.values()],
		observeOwnership: async () => ({ ok: true, claim: null }),
		lifecycle: { run: async (_key: string, work: (lease: unknown) => Promise<unknown>) => await work({}) },
		...extra,
	} as unknown as SessionIndex;
}

/** One indexed session whose recorded writer is, or is not, alive, over the real index and a real session file. */
async function legacyFixture(name: string, live: boolean, materialized: boolean) {
	const fixtureRoot = await mkdtemp(path.join(temp, `${name}-`));
	const claimDir = path.join(fixtureRoot, "claims");
	const file = materialized ? path.join(fixtureRoot, "session.jsonl") : null;
	if (file !== null) await writeFile(file, JSON.stringify({ type: "session", version: 3, id: name, cwd: fixtureRoot, timestamp: "2026-09-29T10:25:25Z" }) + "\n");
	const identity = file ?? `draft:${name}`;
	const values = new Map<string, unknown>();
	values.set("omp.sessionIndex.v1", {
		version: 1, activeTabId: TAB, nextOrdinal: 3,
		entries: [{
			tabId: TAB, origin: "extension", sessionFile: file, sessionId: name, cwd: fixtureRoot,
			scope: { profile: null, sessionDir: null }, sessionDir: null,
			ownership: { ownerGeneration: OWNER, draftIdentity: file === null ? identity : null, releasedAt: null },
			host: { pid: live ? 51704 : 31000, instanceId: null, generation: null, sessionId: name, startedAt: STAMP },
			createdAt: STAMP, lastActiveAt: STAMP,
			ordinal: live ? 1 : 2, availability: "owner-unknown", runIntent: live ? "running" : "stopped",
		}],
	});
	await acquireClaim(claimDir, identity, OWNER, createClaimHolder(4194303));
	const index = new SessionIndexClass({ claimStorageDir: claimDir, store: {
		get<T>(key: string) { return values.get(key) as T | undefined; },
		async update(key: string, value: unknown) { values.set(key, value); },
	} });
	let writerAlive = live;
	const operations: string[] = [];
	const reconciler = createOwnerReconciler({
		readProcessIdentity: async () => ({ kind: "gone" }), isProcessAlive: () => false,
		brokerSlot: () => SLOT, brokerProvenance: () => ({ kind: "slot", slot: SLOT }),
		probeRpc: async () => ({ kind: "unreachable", reason: "dead fixture broker" }),
		probeBrokerSlot: async () => writerAlive ? { kind: "live", pid: 51704 } : { kind: "failed", reason: "dead broker, gone pid" },
		hasTerminal: async () => false,
	} as never);
	const stopPort: RecordedHostStopPort = { stopRecordedHost: async () => {
		assert.equal(index.get(TAB)?.runIntent, "stopped", "stopped intent precedes broker dispatch");
		operations.push("stop legacy child and shutdown broker");
		writerAlive = false;
		return { kind: "stopped", writerGone: true, treeEmpty: true, detail: "verified fixture writer exited; empty broker shut down", slot: SLOT };
	} };
	const w = await world(index);
	w.state.reconciler = reconciler;
	w.state.stopPort = stopPort;
	return { ...w, index, file, operations, root: fixtureRoot };
}

describe("clicking a session row", () => {
	const stopped = (tabId = TAB, sessionFile: string | null = "s.jsonl") => ({ tabId, sessionFile } as Partial<SessionIndexEntry>);

	it("shows history on a first click of a stopped row and launches on a second click of the same row within the interval, after the open still in flight", async t => {
		// The recognizer reads the clock when it is created: the clock is the test's before the window is.
		t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
		const w = await world(fakeIndex([stopped()]));
		const settled: string[] = [];
		w.state.opening.set(TAB, Promise.resolve().then(() => { settled.push("opening settled"); }));
		try {
			await w.actions.click(w.state.context, w.index, sessionRow(TAB, "stopped"));
			t.mock.timers.tick(100);
			await w.actions.click(w.state.context, w.index, sessionRow(TAB, "stopped"));
		} finally {
			t.mock.timers.reset();
		}
		assert.deepEqual(w.opened.map(call => call.slice(1)), [["opened"], ["resumed"]]);
		assert.deepEqual(w.tabsAsked, [TAB], "only the launching click waits for the open of the row");
		assert.deepEqual(settled, ["opening settled"]);
	});

	it("takes a click on another row, a late second click, a live row and a stopped row without a history file for plain opens", async t => {
		t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
		const w = await world(fakeIndex([stopped(), stopped(OTHER_TAB), stopped("tab:fileless", null)]));
		const click = (tabId: string, state: string) => w.actions.click(w.state.context, w.index, sessionRow(tabId, state));
		try {
			await click(TAB, "stopped");
			await click(OTHER_TAB, "stopped");
			await click(TAB, "stopped");
			t.mock.timers.tick(1_000);
			await click(TAB, "stopped");
			await click("tab:fileless", "stopped");
			await click("tab:fileless", "stopped");
			w.state.facts.set(TAB, { open: true, running: true, outcome: null, activity: null });
			await click(TAB, "running");
			await click(TAB, "running");
		} finally {
			t.mock.timers.reset();
		}
		assert.deepEqual(w.opened.map(call => call[1]), Array(8).fill("opened"));
	});

	it("ignores an argument that is not a session row and a row the index no longer has", async () => {
		const w = await world(fakeIndex([]));
		await w.actions.click(w.state.context, w.index, "tab:plain-string");
		await w.actions.click(w.state.context, w.index, { tabId: TAB });
		await w.actions.click(w.state.context, w.index, sessionRow(TAB, "stopped"));
		assert.deepEqual(w.opened, []);
	});
});

describe("opening a process row", () => {
	it("opens the Stats dashboard for the stats row", async () => {
		const w = await world();
		await w.actions.openProcess(w.state.context, w.index, processRow({}, "stats"));
		assert.deepEqual(w.commands, [["omp.openStats"]]);
	});

	it("ignores a row that opens nothing and an argument that is not a process row", async () => {
		const w = await world();
		await w.actions.openProcess(w.state.context, w.index, processRow({}, null));
		await w.actions.openProcess(w.state.context, w.index, sessionRow(TAB, "running"));
		assert.deepEqual([w.opened, w.commands, w.infos, w.warnings], [[], [], [], []]);
	});

	it("opens a session process as a click on its session's row, and says so when that row is not listed any more", async () => {
		const row = sessionRow(TAB, "running");
		const w = await world(fakeIndex([{ tabId: TAB, sessionFile: "s.jsonl" }]));
		w.state.provider = { itemFor: async (tabId: string) => tabId === TAB ? row : undefined };
		await w.actions.openProcess(w.state.context, w.index, processRow({ host: { kind: "session", tabId: TAB } }, "session"));
		assert.deepEqual(w.opened.map(call => [(call[0] as { tabId: string }).tabId, call[1]]), [[TAB, "opened"]]);
		await w.actions.openProcess(w.state.context, w.index, processRow({ host: { kind: "session", tabId: OTHER_TAB } }, "session"));
		assert.deepEqual(w.infos, ["That session is not listed in Sessions any more. Refresh and try again."]);
		assert.equal(w.opened.length, 1);
	});

	it("shows a terminal's editor, or reconnects it from its record, and leaves one another window shows to that window", async () => {
		const w = await world();
		const row = (window: string) => processRow({ slot: "shell-1", window }, "terminal");
		let revealed = 0;
		w.state.tabs.set("shell-1", tabRecord("shell-1", null, { panel: { reveal: () => { revealed++; }, dispose() {} } }));
		await w.actions.openProcess(w.state.context, w.index, row("this-window"));
		assert.equal(revealed, 1);
		w.state.tabs.clear();
		await w.actions.openProcess(w.state.context, w.index, row("this-window"));
		assert.deepEqual(w.warnings, ["This terminal has no record to reconnect it from. Stop it from Sessions if it is not needed."]);
		w.state.shellSlots = { get: slot => slot === "shell-1" ? { slot, cwd: "C:/proj" } : null };
		await w.actions.openProcess(w.state.context, w.index, row("other-window"));
		assert.deepEqual(w.infos, ["This terminal is open in another VS Code window."]);
		assert.deepEqual(w.shellsAttached, []);
		await w.actions.openProcess(w.state.context, w.index, row("this-window"));
		assert.deepEqual(w.shellsAttached, [{ slot: "shell-1", cwd: "C:/proj" }]);
		const refused = await world(null, { attachFolderShell: async () => false });
		refused.state.shellSlots = w.state.shellSlots;
		await refused.actions.openProcess(refused.state.context, refused.index, row("this-window"));
		assert.deepEqual(refused.warnings, ["This terminal could not be reconnected. It may have ended; refresh Sessions and try again."]);
	});
});

describe("going to a session from anywhere", () => {
	const listed = (tabId: string, folder: string, status: string) => ({ item: Object.assign(sessionRow(tabId, "running"), { iconPath: new stub.ThemeIcon("play"), description: status }), folder });

	it("lists the rows the Sessions view shows in its order, ended by New Session, and a pick is a click on that row", async () => {
		const w = await world(fakeIndex([{ tabId: TAB, sessionFile: "s.jsonl" }]));
		w.state.provider = { listedSessions: () => [listed(TAB, "proj", "running"), listed(OTHER_TAB, "", "idle")] };
		let offered: { label: string; description?: string; kind?: number; row?: unknown }[] = [];
		w.state.picked = items => { offered = items as typeof offered; return items[0]; };
		await w.actions.goTo(w.state.context, w.index);
		assert.deepEqual(offered.map(item => [item.label, item.description ?? null, item.kind ?? null]), [
			[`$(play) Session ${TAB}`, "proj · running", null],
			[`$(play) Session ${OTHER_TAB}`, "idle", null],
			["", null, stub.QuickPickItemKind.Separator],
			["$(add) New Session…", null, null],
		]);
		assert.deepEqual(w.opened.map(call => [(call[0] as { tabId: string }).tabId, call[1]]), [[TAB, "opened"]]);
	});

	it("runs New Session for the last choice, and does nothing when the pick is dismissed or the view does not exist", async () => {
		const w = await world();
		w.state.provider = { listedSessions: () => [] };
		let offered: { label: string }[] = [];
		w.state.picked = items => { offered = items; return items.at(-1); };
		await w.actions.goTo(w.state.context, w.index);
		assert.deepEqual(offered.map(item => item.label), ["$(add) New Session…"], "no separator without a session");
		assert.deepEqual(w.commands, [["omp.newSession"]]);
		w.state.picked = () => undefined;
		await w.actions.goTo(w.state.context, w.index);
		w.state.provider = undefined;
		await w.actions.goTo(w.state.context, w.index);
		assert.deepEqual([w.commands.length, w.opened], [1, []]);
	});
});

describe("forgetting a launcher entry", () => {
	it("drops an unowned legacy draft at once, without a dialog or a completion notice", async () => {
		const f = await legacyFixture("forget-dead", false, false);
		await f.actions.forget(f.index, TAB);
		assert.equal(f.index.get(TAB), null);
		assert.deepEqual([f.dialogs, f.infos, f.warnings, f.errors], [[], [], [], []]);
		assert.deepEqual(f.refreshes, [undefined]);
	});

	it("drops every record this window kept for the conversation: its panels, editor slots, bridge editors and last outcome", async () => {
		const disposed: string[] = [];
		const index = fakeIndex([{ tabId: TAB }, { tabId: OTHER_TAB }], { remove: async () => ({ removed: true, detail: "" }) });
		const w = await world(index);
		const panel = (name: string) => ({ reveal() {}, dispose: () => { disposed.push(name); } });
		w.state.tabs.set("controller", tabRecord("controller", TAB, { panel: panel("controller") }));
		w.state.tabs.set("passive", tabRecord("passive", TAB, { panel: panel("passive") }));
		w.state.tabs.set("other", tabRecord("other", OTHER_TAB, { panel: panel("other") }));
		w.state.outcomes.set(TAB, { status: "draft" });
		w.state.outcomes.set(OTHER_TAB, { status: "draft" });
		await w.actions.forget(index, { tabId: TAB });
		assert.deepEqual(disposed, ["controller", "passive"]);
		assert.deepEqual([...w.state.tabs.keys()], ["other"]);
		assert.deepEqual(w.slotsRemoved, ["controller", "passive"]);
		assert.deepEqual(w.editorsReleased, ["controller", "passive"]);
		assert.deepEqual(w.conversationsClosed, [TAB]);
		assert.deepEqual([...w.state.outcomes.keys()], [OTHER_TAB]);
	});

	it("says what the index refused, repaints, and keeps this window's records", async () => {
		const index = fakeIndex([{ tabId: TAB }], { remove: async () => ({ removed: false, detail: "Another window runs this session." }) });
		const w = await world(index);
		w.state.tabs.set("controller", tabRecord("controller", TAB));
		await w.actions.forget(index, TAB);
		assert.deepEqual(w.warnings, ["Another window runs this session."]);
		assert.deepEqual([w.state.tabs.size, w.conversationsClosed, w.refreshes], [1, [], [undefined]]);
	});

	it("reports a session the index no longer has, and asks which session when the command names none", async () => {
		const index = fakeIndex([], { remove: async () => { throw new Error("must not be reached"); } });
		const w = await world(index);
		await w.actions.forget(index, TAB);
		assert.deepEqual(w.errors, ["This session is no longer in Sessions. Refresh and try again."]);
		const asked: string[] = [];
		const picking = await world(index, { pickIndexedTab: async (_index, title) => { asked.push(title); return null; } });
		await picking.actions.forget(index, undefined);
		assert.deepEqual([asked, picking.errors], [["Forget a launcher entry"], []]);
	});
});

describe("stopping a session's recorded process", () => {
	const recordedHost = (overrides: Record<string, unknown> = {}) => ({ pid: 51704, startedAt: STAMP, transport: "rpc", rpc: null, ...overrides });

	it("refuses with a reason when nothing names a session, when the row has no process, and when the broker slot cannot be named", async () => {
		const index = fakeIndex([{ tabId: TAB, cwd: "C:/proj", host: null }, { tabId: OTHER_TAB, cwd: "C:/proj", host: recordedHost() as never }]);
		const w = await world(index);
		assert.equal(await w.actions.stopHost(w.state.context, index, undefined), false);
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB), false);
		w.state.provenance = { kind: "none" };
		assert.equal(await w.actions.stopHost(w.state.context, index, OTHER_TAB), false);
		w.state.provenance = { kind: "unreadable" };
		assert.equal(await w.actions.stopHost(w.state.context, index, OTHER_TAB), false);
		assert.deepEqual(w.warnings, [
			"Select an OMP session to stop.",
			"This session has no running process that this window can stop. Refresh Sessions and try again.",
			"This session's connection details are missing. Reopen its editor and try again.",
			"This session's connection details could not be read. Refresh Sessions and try again.",
		]);
		assert.deepEqual([w.dialogs, w.stopPortRequests], [[], []]);
	});

	it("asks once, naming the folder, and says nothing was stopped when the dialog is dismissed", async () => {
		const index = fakeIndex([{ tabId: TAB, cwd: "C:/proj/app", host: recordedHost() as never }]);
		const w = await world(index);
		w.state.answer = undefined;
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB), false);
		assert.deepEqual(w.dialogs.map(dialog => [dialog.message, dialog.items]), [["Stop the session in app?", [STOP_LABEL]]]);
		assert.match(w.dialogs[0]!.detail ?? "", /Unsaved replies and work in progress may be lost/);
		assert.deepEqual([w.infos, w.stopPortRequests, [...w.state.stopping]], [["Nothing was stopped."], [], []]);
	});

	it("stops through the index with the slot the confirmation named, shows the row as stopping meanwhile, then forgets the slot, the outcome and the control material", async () => {
		const f = await legacyFixture("stop-live", true, true);
		const slotsForgotten: string[] = [];
		f.state.brokerSlots = { forget: async (slot: string) => { slotsForgotten.push(slot); } } as never;
		f.state.outcomes.set(TAB, { status: "draft" });
		const seenStopping: boolean[] = [];
		const stopping = f.state.stopPort!.stopRecordedHost;
		f.state.stopPort = { stopRecordedHost: async (...args) => { seenStopping.push(f.state.stopping.has(TAB)); return await stopping(...args); } };
		try {
			assert.equal(await f.actions.stopHost(f.state.context, f.index, TAB), true);
			assert.deepEqual(f.operations, ["stop legacy child and shutdown broker"]);
			assert.deepEqual(f.stopPortRequests, [[SLOT, null]]);
			assert.deepEqual(seenStopping, [true]);
			assert.deepEqual([...f.state.stopping], []);
			assert.deepEqual(slotsForgotten, [SLOT]);
			assert.deepEqual([f.state.outcomes.size, f.released], [0, [[TAB, OWNER]]]);
			assert.deepEqual(f.refreshes, [undefined, undefined], "repainted when the stop began and when it ended");
			assert.deepEqual(f.dialogs.map(dialog => dialog.items), [[STOP_LABEL]]);
		} finally {
			await f.index.closeSession(TAB, { confirmedStopped: true });
		}
	});

	it("reports what an unconfirmed stop says and keeps the slot, the outcome and the control material", async () => {
		const f = await legacyFixture("stop-unknown", true, true);
		f.state.brokerSlots = { forget: async () => { throw new Error("must not be reached"); } } as never;
		f.state.outcomes.set(TAB, { status: "draft" });
		f.state.stopPort = { stopRecordedHost: async () => ({ kind: "unknown", detail: "The session could not be confirmed stopped." }) };
		try {
			assert.equal(await f.actions.stopHost(f.state.context, f.index, TAB), false);
			assert.equal(f.warnings.length, 1);
			assert.match(f.warnings[0]!, /^The session could not be confirmed stopped\./);
			assert.deepEqual([f.state.outcomes.size, f.released, [...f.state.stopping]], [1, [], []]);
		} finally {
			await f.index.closeSession(TAB, { confirmedStopped: true });
		}
	});

	it("binds a stop its caller already confirmed to exactly the attempt, slot and broker it read, and asks nothing", async () => {
		const rpc = { brokerId: "broker-1", brokerGeneration: "gen-1" };
		const index = fakeIndex([{ tabId: TAB, cwd: "C:/proj", host: recordedHost({ rpc }) as never }], { stopRecordedHost: async () => ({ stopped: false, detail: "The fixture index stopped nothing.", slot: null }) });
		const recorded = { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1", attemptStartedAt: STAMP, pid: 51704 };
		const w = await world(index);
		w.state.stopPort = { stopRecordedHost: async () => ({ kind: "unknown", detail: "not reached" }) };
		for (const changed of [{ pid: 1 }, { attemptStartedAt: "2026-09-29T11:00:00Z" }, { slot: "host:other" }, { brokerId: "broker-2" }, { brokerGeneration: "gen-2" }]) {
			assert.equal(await w.actions.stopHost(w.state.context, index, TAB, { recorded: { ...recorded, ...changed } }), false);
		}
		assert.deepEqual(w.warnings, Array(5).fill("The session's recorded process changed while the stop was being prepared, so nothing was stopped."));
		assert.deepEqual([w.dialogs, w.stopPortRequests], [[], []]);
		await w.actions.stopHost(w.state.context, index, TAB, { recorded });
		assert.deepEqual(w.stopPortRequests, [[SLOT, { brokerId: "broker-1", brokerGeneration: "gen-1" }]]);
		assert.deepEqual(w.dialogs, []);
	});

	it("stops this window's own runtime through its own flow, bound to the captured facts when its caller asked nothing", async () => {
		const identity = { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1" };
		const runtime = { identity, kind: "chat", pid: 7 } as unknown as SessionHostRuntime;
		const index = fakeIndex([{ tabId: TAB, cwd: "C:/proj", host: recordedHost() as never }]);
		const w = await world(index);
		const state = tabRecord("slot-1", TAB, { runtime });
		w.state.tabs.set("slot-1", state);
		w.state.transition = async () => ({ epoch: "e1" });
		const recorded = { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1", attemptStartedAt: STAMP, pid: 51704 };
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB, { recorded: { ...recorded, brokerGeneration: "other" } }), false);
		assert.equal(w.confirmedStops.length, 0);
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB), true);
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB, { recorded, gracefulOnly: true }), true);
		assert.deepEqual(w.confirmedStops, [
			[TAB, state, runtime, "Stop", undefined],
			[TAB, state, runtime, "Stop", { conflicting: false, captured: { epoch: "e1" }, gracefulOnly: true }],
		]);
	});

	it("reattaches a native writer only, and refuses when this window still cannot reach it", async () => {
		const index = fakeIndex([{ tabId: TAB, cwd: "C:/proj", sessionFile: "s.jsonl", host: recordedHost({ transport: "native" }) as never, ownership: { ownerGeneration: OWNER, draftIdentity: null } as never }]);
		const w = await world(index);
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB), false);
		assert.deepEqual(w.warnings, ["This window could not reconnect to the running session. Use /exit in its Terminal, or reopen its editor and try again."]);
		w.state.reconciler = { reconcile: async () => ({ kind: "attachable", host: { pid: 51704 }, detail: "" }) } as unknown as OwnerReconciler;
		const restored: unknown[] = [];
		Object.assign(index, { restore: async (tabId: string, options: { launcher: { launch(): Promise<unknown> } }) => { restored.push([tabId, await options.launcher.launch()]); } });
		assert.equal(await w.actions.stopHost(w.state.context, index, TAB), false);
		assert.deepEqual(restored, [[TAB, { state: "not-started", reason: "A lifecycle action only reattaches an existing native writer." }]]);
		assert.deepEqual(w.dialogs, []);
	});
});

describe("killing a session or a process", () => {
	it("needs a tree row or a known session: it never falls back to the front session", async () => {
		const index = fakeIndex([]);
		const w = await world(index);
		await w.actions.kill(w.state.context, index, undefined);
		await w.actions.kill(w.state.context, index, "tab:unknown");
		assert.deepEqual(w.warnings, Array(2).fill("Select a session or a process in Sessions to kill."));
		assert.deepEqual(w.notices, []);
	});

	it("reads the live rows for a session that recorded no host, and says there is nothing to kill when none is Desk's", async () => {
		const index = fakeIndex([{ tabId: TAB, cwd: "C:/proj", host: null }]);
		const w = await world(index);
		let reads = 0;
		w.state.processes = { refresh: async () => { reads++; return { rows: [] }; }, sync() {}, touch() {}, serveStopRequest: async () => [] };
		w.state.provider = { headlineFor: () => "Fixture session" };
		stub.workspace.name = "proj";
		try {
			await w.actions.kill(w.state.context, index, sessionRow(TAB, "stopped"));
		} finally {
			stub.workspace.name = undefined;
		}
		assert.deepEqual(w.notices, ["OMP: This row has no process Desk knows of, so there is nothing to kill."]);
		assert.equal(reads, 1, "the rows the kill plans from");
		assert.ok(w.logged.some(line => line.includes('requested by the Sessions menu of window "proj" (this-win)')), JSON.stringify(w.logged));
	});

	describe("of a session whose recorded process is already gone", () => {
		// Process ids no process has: the kill proves them gone and kills nothing.
		const BROKER_PID = 4194300;
		const CHILD_PID = 4194296;
		const recordedIdentity = { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1", brokerPid: BROKER_PID, brokerCreationTime: "broker-created", childPid: CHILD_PID, childCreationTime: "child-created" };
		const recordedEntry = () => ({ tabId: TAB, cwd: "C:/proj", host: { pid: CHILD_PID, startedAt: STAMP, transport: "rpc", rpc: recordedIdentity } as never, ownership: { ownerGeneration: OWNER, draftIdentity: null } as never });

		async function killed(reconcile: (tabId: string, captured: unknown) => Promise<unknown>) {
			const reconciled: unknown[][] = [];
			const index = fakeIndex([recordedEntry()], { reconcileKilledHost: async (...args: unknown[]) => { reconciled.push(args.slice(0, 2)); return await reconcile(args[0] as string, args[1]); } });
			const w = await world(index);
			const slotsForgotten: string[] = [];
			w.state.brokerSlots = { forget: async (slot: string) => { slotsForgotten.push(slot); } } as never;
			w.state.outcomes.set(TAB, { status: "draft" });
			w.state.processes = { refresh: async () => ({ rows: [] }), sync() {}, touch() {}, serveStopRequest: async () => [] };
			w.state.provider = { headlineFor: () => "Fixture session" };
			await w.actions.kill(w.state.context, index, sessionRow(TAB, "stopped"));
			return { w, reconciled, slotsForgotten };
		}

		it("takes the recorded process from the index's host record, then records the row stopped and forgets the slot, the outcome and the control material of that incarnation", async () => {
			const { w, reconciled, slotsForgotten } = await killed(async () => ({ kind: "recorded", slot: SLOT }));
			assert.deepEqual(reconciled, [[TAB, { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1", attemptStartedAt: STAMP, hostPid: CHILD_PID }]]);
			assert.deepEqual(slotsForgotten, [SLOT]);
			assert.deepEqual([w.state.outcomes.size, w.released], [0, [[TAB, OWNER]]]);
			assert.ok(w.logged.includes(`tab ${TAB}: after Kill: the row is recorded as stopped`));
			assert.deepEqual(w.refreshes, [{ ownership: true }], "the launcher is re-read with a fresh ownership read once the kill ended");
		});

		it("takes this window's own runtime identity over the index's record", async () => {
			const reconciled: unknown[] = [];
			const index = fakeIndex([{ ...recordedEntry(), host: { pid: CHILD_PID, startedAt: STAMP, transport: "rpc", rpc: null } as never }], { reconcileKilledHost: async (_tabId: string, captured: unknown) => { reconciled.push(captured); return { kind: "skipped", why: "driven", detail: "driven here" }; } });
			const w = await world(index);
			w.state.tabs.set("slot-1", tabRecord("slot-1", TAB, { runtime: { identity: recordedIdentity, kind: "chat", pid: CHILD_PID } as unknown as SessionHostRuntime }));
			w.state.processes = { refresh: async () => ({ rows: [] }), sync() {}, touch() {}, serveStopRequest: async () => [] };
			await w.actions.kill(w.state.context, index, sessionRow(TAB, "running"));
			assert.deepEqual(reconciled, [{ slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1", attemptStartedAt: STAMP, hostPid: CHILD_PID }]);
		});

		it("leaves a row a rival window holds, or that records a newer launch, alone and logs why", async () => {
			const { w, slotsForgotten } = await killed(async () => ({ kind: "skipped", why: "changed", detail: "The row records another process than the one that was killed." }));
			assert.ok(w.logged.includes(`tab ${TAB}: after Kill: The row records another process than the one that was killed.`));
			assert.deepEqual([slotsForgotten, w.released, w.state.outcomes.size], [[], [], 1]);
			assert.deepEqual(w.warnings, [], "a benign skip is not an error");
		});

		it("tells the user when the row could not be recorded stopped, and keeps what it holds", async () => {
			const { w, slotsForgotten } = await killed(async () => ({ kind: "failed", detail: "The row recorded neither a session file nor a reserved identity." }));
			assert.ok(w.logged.includes(`tab ${TAB}: after Kill: The row recorded neither a session file nor a reserved identity.`));
			assert.deepEqual([slotsForgotten, w.released, w.state.outcomes.size], [[], [], 1]);
			assert.equal(w.notices.length, 2);
			assert.match(w.notices.at(-1)!, /was killed, but Desk could not update its own records/);
		});
	});
});

describe("the writer a session row has", () => {
	it("is this window's own runtime when it has one", async () => {
		const index = fakeIndex([{ tabId: TAB }]);
		const w = await world(index);
		w.state.tabs.set("slot-1", tabRecord("slot-1", TAB, { runtime: { pid: 4321 } as unknown as SessionHostRuntime }));
		assert.equal(await w.actions.verifiedOwnedWriterPid(index, TAB), 4321);
		assert.equal(await w.actions.verifiedOwnedWriterPid(index, OTHER_TAB), null, "a row the index does not have has no writer");
	});

	it("is the live pid the reconciler proves, never a recorded pid by itself", async () => {
		const live = await legacyFixture("writer-live", true, true);
		const dead = await legacyFixture("writer-dead", false, true);
		try {
			assert.equal(await live.actions.verifiedOwnedWriterPid(live.index, TAB), 51704);
			assert.equal(await dead.actions.verifiedOwnedWriterPid(dead.index, TAB), null);
			dead.state.reconciler = { reconcile: async () => { throw new Error("probe failed"); } } as unknown as OwnerReconciler;
			assert.equal(await dead.actions.verifiedOwnedWriterPid(dead.index, TAB), null, "a probe that fails proves no writer");
		} finally {
			await live.index.closeSession(TAB, { confirmedStopped: true });
		}
	});

	it("is none while another window's live claim holds the row, without a probe", async () => {
		const f = await legacyFixture("writer-rival", true, true);
		const rival = await acquireClaim(path.join(f.root, "rival-claims"), "rival-identity", OWNER, createClaimHolder());
		const observed = { ok: true, claim: { ...(rival as object), holderId: "another-holder" } };
		Object.assign(f.index, { observeOwnership: async () => observed });
		f.state.reconciler = { reconcile: async () => { throw new Error("must not be probed"); } } as unknown as OwnerReconciler;
		try {
			assert.equal(await f.actions.verifiedOwnedWriterPid(f.index, TAB), null);
		} finally {
			await rival.release();
			await f.index.closeSession(TAB, { confirmedStopped: true });
		}
	});
});

describe("deleting a session", () => {
	it("deletes an unowned materialized row with only the exact-path confirmation, which keeps filesystem paths out of the modal", async () => {
		const f = await legacyFixture("delete-dead", false, true);
		f.index.observeOwnershipOfFile = async () => ({ ok: false, detail: "Fixture claim storage is unreadable." });
		assert.equal(await f.actions.confirmAndDelete(f.index, TAB), true);
		assert.equal(f.index.get(TAB), null);
		await assert.rejects(readFile(f.file!), { code: "ENOENT" });
		assert.equal(f.dialogs.length, 1);
		assert.equal(f.dialogs[0]!.detail!.includes(f.file!), false, "filesystem paths stay out of the modal");
		assert.equal(f.dialogs[0]!.detail!.split(/[.!?]\s+/).length <= 2, true);
		assert.deepEqual(f.dialogs[0]!.items, ["Delete"]);
		assert.deepEqual(f.operations, []);
		assert.deepEqual(f.forgotten, [TAB], "the turn activity of the conversation is dropped with it");
	});

	it("leaves history and index unchanged, with no completion notice, when the confirmation is cancelled", async () => {
		const f = await legacyFixture("cancel-delete", false, true);
		const before = await readFile(f.file!, "utf8");
		f.state.answer = undefined;
		assert.equal(await f.actions.confirmAndDelete(f.index, TAB), false);
		assert.ok(f.index.get(TAB));
		assert.equal(await readFile(f.file!, "utf8"), before);
		assert.deepEqual([f.operations, f.infos, f.warnings, f.errors, f.forgotten], [[], [], [], [], []]);
	});

	it("stops the verified live writer after the one confirmation, then deletes only the exact file", async () => {
		const f = await legacyFixture("live-delete", true, true);
		assert.equal(await f.actions.confirmAndDelete(f.index, TAB), true);
		assert.deepEqual(f.operations, ["stop legacy child and shutdown broker"]);
		assert.equal(f.dialogs.length, 1);
		assert.deepEqual(f.dialogs[0]!.items, ["Delete"]);
		assert.equal(f.index.get(TAB), null);
		await assert.rejects(readFile(f.file!), { code: "ENOENT" });
		assert.deepEqual([...f.state.stopping], []);
	});

	it("takes the row from either command argument and confirms before it removes the file", async () => {
		for (const argument of [{ tabId: TAB }, TAB]) {
			const f = await legacyFixture("delete-argument", false, true);
			let asked = 0;
			f.state.beforeAnswer = async () => {
				asked++;
				assert.equal(f.index.get(TAB)?.runIntent, "stopped");
				assert.ok(await readFile(f.file!, "utf8"), "the confirmation precedes file removal");
			};
			f.state.answer = undefined;
			await f.actions.delete(f.index, argument);
			assert.ok(await readFile(f.file!, "utf8"), "a dismissed confirmation keeps the file");
			f.state.answer = "first";
			await f.actions.delete(f.index, argument);
			assert.equal(asked, 2);
			assert.deepEqual(f.dialogs.map(dialog => dialog.modal), [true, true], "the confirmation is modal");
			assert.equal(f.index.get(TAB), null);
			await assert.rejects(readFile(f.file!, "utf8"), { code: "ENOENT" });
			assert.deepEqual(f.opened, [], "Delete does not start a stopped session");
		}
	});

	it("asks which session when the command names none, and stops when none is picked", async () => {
		const f = await legacyFixture("delete-pick", false, true);
		const asked: string[] = [];
		const picked = await world(f.index, { pickIndexedTab: async (_index, title) => { asked.push(title); return null; } });
		await picked.actions.delete(f.index, undefined);
		assert.deepEqual([asked, picked.dialogs], [["Delete an OMP session"], []]);
		assert.ok(f.index.get(TAB));
	});

	it("says a session the index no longer has was not deleted", async () => {
		const f = await legacyFixture("delete-gone", false, true);
		assert.equal(await f.actions.confirmAndDelete(f.index, OTHER_TAB), false);
		assert.deepEqual(f.errors, ["This session is no longer indexed, so nothing was deleted."]);
		assert.deepEqual(f.dialogs, []);
	});

	it("refuses to delete a session this window is already changing or stopping", async () => {
		const f = await legacyFixture("delete-transition", true, true);
		f.state.tabs.set("slot-1", tabRecord("slot-1", TAB, { runtime: { kind: "chat", pid: 51704 } as unknown as SessionHostRuntime, transitioning: true }));
		try {
			assert.equal(await f.actions.confirmAndDelete(f.index, TAB), false);
			assert.deepEqual(f.warnings, ["The session is already changing or stopping; nothing was deleted."]);
			assert.deepEqual(f.dialogs, []);
			assert.ok(f.index.get(TAB));
		} finally {
			await f.index.closeSession(TAB, { confirmedStopped: true });
		}
	});

	it("fences a running session's admission while it reads the facts the deletion binds to, and lifts the fence when the deletion did not go on", async () => {
		const f = await legacyFixture("delete-running", true, true);
		const state = tabRecord("slot-1", TAB, { runtime: { kind: "chat", pid: 51704 } as unknown as SessionHostRuntime });
		f.state.tabs.set("slot-1", state);
		const fenced: boolean[] = [];
		const fence = f.deps.fenceSessionAdmission;
		const guarded = await world(f.index, { fenceSessionAdmission: (index, tab, value) => { fenced.push(value); fence(index, tab, value); } });
		guarded.state.tabs.set("slot-1", state);
		guarded.state.reconciler = f.state.reconciler;
		guarded.state.answer = undefined;
		guarded.state.transition = async () => ({ epoch: "e1" });
		try {
			assert.equal(await guarded.actions.confirmAndDelete(f.index, TAB), false);
			assert.deepEqual(fenced, [true, false]);
			assert.equal(state.transitioning, false);
			assert.ok(f.index.get(TAB));
		} finally {
			await f.index.closeSession(TAB, { confirmedStopped: true });
		}
	});

	it("tells the user the session could not be checked, repaints, and deletes nothing when reading its state fails", async () => {
		const f = await legacyFixture("delete-unreadable", true, true);
		const state = tabRecord("slot-1", TAB, { runtime: { kind: "chat", pid: 51704 } as unknown as SessionHostRuntime });
		f.state.tabs.set("slot-1", state);
		f.state.transition = async () => { throw new Error("Session state read timed out."); };
		try {
			assert.equal(await f.actions.confirmAndDelete(f.index, TAB), false);
			assert.deepEqual(f.errors, ["The session could not be checked for deletion. Nothing was deleted. Refresh Sessions and try again."]);
			assert.ok(f.logged.includes("session deletion preparation failed: Session state read timed out."));
			assert.deepEqual(f.refreshes, [undefined]);
			assert.deepEqual(f.dialogs, []);
			assert.ok(f.index.get(TAB));
		} finally {
			await f.index.closeSession(TAB, { confirmedStopped: true });
		}
	});
});

describe("refreshing the launcher", () => {
	it("adopts the newest committed catalog revision and re-reads the rows with a fresh ownership read", async () => {
		const w = await world();
		const folders = { name: "folders" };
		w.state.folders = folders;
		w.actions.refresh(w.index);
		assert.deepEqual(w.catalogAdoptions, [[folders]]);
		assert.deepEqual(w.refreshes, [{ ownership: true }]);
		assert.deepEqual(w.order, ["adopt", "refresh"], "the newest catalog revision is adopted before the rows are re-read");
	});

	it("still re-reads without folders, and logs an adoption that failed instead of throwing", async () => {
		const w = await world(null, { adoptCatalogChanges: async () => { throw new Error("catalog locked"); } });
		w.actions.refresh(w.index);
		assert.deepEqual(w.refreshes, [{ ownership: true }]);
		w.state.folders = {};
		w.actions.refresh(w.index);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.ok(w.logged.includes("catalog: the newest revision could not be adopted: catalog locked"));
	});

	it("warns about a folder-list change that could not be saved, and about nothing else", async () => {
		const w = await world();
		w.actions.reportFolderSaveFailure({ persistError: null } as never);
		assert.deepEqual(w.warnings, []);
		w.actions.reportFolderSaveFailure({ persistError: "The folder list could not be saved." } as never);
		assert.deepEqual(w.warnings, ["The folder list could not be saved."]);
	});
});

describe("the processes of the Sessions view", () => {
	it("registers them once, publishes what the broker registry and the session index say, and keeps the handle the window reads", async () => {
		const index = fakeIndex([
			{ tabId: TAB, cwd: "C:/proj", host: { pid: 51704, startedAt: STAMP, transport: "rpc", rpc: { slot: "host:recorded" } } as never },
			{ tabId: OTHER_TAB, cwd: "C:/other", host: { pid: 9, startedAt: STAMP, transport: "rpc", rpc: null } as never },
			{ tabId: "tab:stopped", cwd: "C:/stopped", host: null },
		]);
		const provenanceAsked: string[] = [];
		const w = await world(index, { brokerProvenanceFor: tabId => { provenanceAsked.push(tabId); return { kind: "none" }; } });
		const published: { rows: { id: string; host: unknown }[]; unreadable: number }[] = [];
		const view = { message: undefined as string | undefined, visible: false };
		w.state.view = view;
		w.state.provider = { headlineFor: (tabId: string) => `Headline of ${tabId}`, displayedState: () => "otherWindow", setProcesses: (snapshot: never) => { published.push(snapshot); } };
		w.state.facts.set(TAB, { open: true, running: true, outcome: null, activity: null });
		const storage = await mkdtemp(path.join(temp, "storage-"));
		const context = { globalStorageUri: { fsPath: storage }, subscriptions: [] as { dispose(): void }[], extensionUri: { fsPath: storage } };
		const folders = { name: "folders" };
		w.actions.setupProcesses(context as never, index as never, folders as never);
		try {
			assert.ok(w.state.processes !== null, "the handle is kept for the window");
			assert.deepEqual([...stub.commands.registered.keys()].filter(id => id.startsWith("omp.")).sort(), ["omp.killAll", "omp.openStats", "omp.refreshProcesses", "omp.stopOrphanedProcesses", "omp.stopProcess"]);
			const snapshot = await w.state.processes!.refresh();
			assert.equal(published.at(-1), snapshot, "every read is served to the view");
			assert.deepEqual(provenanceAsked.sort(), [OTHER_TAB, TAB].sort(), "a row with a recorded host asks for its slot provenance, a row with none does not");
			assert.deepEqual(w.catalogAdoptions, [[folders]], "an explicit read re-reads the shared catalog first");
			assert.equal(view.message, undefined);
			assert.deepEqual(w.refreshes, [], "reading the registry asks the launcher for nothing");
		} finally {
			for (const subscription of context.subscriptions) subscription.dispose();
		}
	});
});

describe("the broker provenance of a row", () => {
	const table = (answers: Record<string, BrokerSlotProvenance>) => ({
		provenanceFor: (keys: { conversation?: string | null; editor?: string | null }) => answers[keys.conversation != null ? `conversation:${keys.conversation}` : `editor:${keys.editor}`] ?? { kind: "none" },
	}) as unknown as BrokerSlotStore;
	const sources = (brokerSlots: BrokerSlotStore | undefined, bindings: { role: string; slotId: string }[] = []) => ({ brokerSlots, slotsForConversation: () => bindings });

	it("is unreadable without a slot table, never `none`", () => {
		assert.deepEqual(readBrokerProvenance(sources(undefined), TAB), { kind: "unreadable" });
	});

	it("is what the conversation's own entry says when it says anything", () => {
		assert.deepEqual(readBrokerProvenance(sources(table({ [`conversation:${TAB}`]: { kind: "slot", slot: "host:a" } })), TAB), { kind: "slot", slot: "host:a" });
		assert.deepEqual(readBrokerProvenance(sources(table({ [`conversation:${TAB}`]: { kind: "unreadable" } }), [{ role: "controlling", slotId: "e1" }]), TAB), { kind: "unreadable" });
	});

	it("falls back to the slot recorded for the editor that controls the conversation, and to nothing a passive editor says", () => {
		const slots = table({ "editor:controller": { kind: "slot", slot: "host:editor" }, "editor:passive": { kind: "slot", slot: "host:passive" } });
		assert.deepEqual(readBrokerProvenance(sources(slots, [{ role: "passive", slotId: "passive" }, { role: "controlling", slotId: "controller" }]), TAB), { kind: "slot", slot: "host:editor" });
		assert.deepEqual(readBrokerProvenance(sources(slots, [{ role: "passive", slotId: "passive" }]), TAB), { kind: "none" });
	});

	it("stays unreadable when an editor's entry was unreadable and no other editor named a slot", () => {
		const slots = table({ "editor:broken": { kind: "unreadable" } });
		assert.deepEqual(readBrokerProvenance(sources(slots, [{ role: "controlling", slotId: "broken" }, { role: "controlling", slotId: "empty" }]), TAB), { kind: "unreadable" });
		assert.deepEqual(readBrokerProvenance(sources(slots, [{ role: "controlling", slotId: "empty" }]), TAB), { kind: "none" });
	});
});

describe("the transport that stops a recorded host", () => {
	const entry = (overrides: Record<string, unknown> = {}) =>
		({ tabId: TAB, host: { pid: 51704, startedAt: STAMP, transport: "rpc", rpc: { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1" } }, ...overrides }) as unknown as SessionIndexEntry;
	const port = (provenance: BrokerSlotProvenance, client: unknown = null, expectedSlot = SLOT, expectedBroker: { brokerId: string; brokerGeneration: string } | null = null) => {
		const logged: string[] = [];
		const stop = createRecordedHostStopPort({ brokerProvenanceFor: () => provenance, attachBrokerClient: async () => client as never, log: message => { logged.push(message); } }, expectedSlot, expectedBroker);
		return { stop: (row: SessionIndexEntry) => stop.stopRecordedHost(row), logged };
	};

	it("refuses, saying nothing was stopped, when the row's slot or broker is not the one the confirmation named", async () => {
		const detail = "This session changed while the confirmation was open. Nothing was stopped; try Stop again.";
		assert.deepEqual(await port({ kind: "slot", slot: "host:other" }).stop(entry()), { kind: "unknown", detail });
		const broker = { brokerId: "broker-1", brokerGeneration: "gen-1" };
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, null, SLOT, { ...broker, brokerGeneration: "gen-2" }).stop(entry()), { kind: "unknown", detail });
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, null, SLOT, broker).stop(entry({ host: { pid: 1, startedAt: STAMP, transport: "rpc", rpc: null } })), { kind: "unknown", detail });
	});

	it("names an unreadable or missing slot table as such, and never signals a pid", async () => {
		assert.deepEqual(await port({ kind: "unreadable" }).stop(entry()), { kind: "unknown", detail: "This session's connection details could not be read. Refresh Sessions and try again." });
		assert.deepEqual(await port({ kind: "none" }).stop(entry()), { kind: "unknown", detail: "This session's connection details are missing. Reopen its editor and try Stop again." });
	});

	it("refuses without a broker client, and for a native writer, which only its own Terminal stops", async () => {
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, null).stop(entry()), { kind: "unknown", detail: "This session is disconnected. Reopen its editor and try Stop again." });
		const native = entry({ host: { pid: 1, startedAt: STAMP, transport: "native", rpc: null } });
		assert.deepEqual(await port({ kind: "slot", slot: SLOT }, {}).stop(native), { kind: "unknown", detail: "Stop this session from its Terminal editor, or use /exit there." });
	});
});

/** Another window of this profile holds the session: a live holder takes the claim over the same exact transcript. */
async function holdAsAnotherWindow(index: SessionIndex, fixtureRoot: string, transcript: string) {
	const rival = await acquireClaim(path.join(fixtureRoot, "claims"), transcript, "rival-owner", createClaimHolder());
	const holder = async (): Promise<string | null> => {
		const seen = await index.observeOwnership(TAB);
		assert.ok(seen.ok);
		return seen.claim?.holderId ?? null;
	};
	const holderId = await holder();
	assert.ok(holderId !== null && holderId !== index.claimHolder.id, "the claim is another window's");
	return { rival, holderId, holder };
}

describe("destructive actions by what holds the session", () => {
	describe("Forget", () => {
		it("drops a stopped row without touching its transcript, and never asks", async () => {
			const f = await legacyFixture("forget-stopped", false, true);
			const before = await readFile(f.file!, "utf8");
			await f.actions.forget(f.index, TAB);
			assert.equal(f.index.get(TAB), null);
			assert.equal(await readFile(f.file!, "utf8"), before, "Forget removes launcher metadata only");
			assert.deepEqual([f.dialogs, f.warnings, f.errors], [[], [], []]);
		});

		it("refuses a row whose OMP process is verified running, and keeps the row and this window's records", async () => {
			const f = await legacyFixture("forget-running", true, true);
			f.state.tabs.set("slot-1", tabRecord("slot-1", TAB));
			f.state.outcomes.set(TAB, { status: "draft" });
			try {
				await f.actions.forget(f.index, TAB);
				assert.ok(f.index.get(TAB), "a running session stays in Sessions");
				assert.equal(f.warnings.length, 1, "the user is told why");
				assert.deepEqual([f.state.tabs.size, f.conversationsClosed, f.state.outcomes.size], [1, [], 1]);
			} finally {
				await f.index.closeSession(TAB, { confirmedStopped: true });
			}
		});

		it("refuses a row another live window holds, and takes nothing from that window's claim", async () => {
			const f = await legacyFixture("forget-held", false, true);
			const held = await holdAsAnotherWindow(f.index, f.root, f.file!);
			try {
				await f.actions.forget(f.index, TAB);
				assert.ok(f.index.get(TAB));
				assert.equal(f.warnings.length, 1);
				assert.equal(await held.holder(), held.holderId);
			} finally {
				await held.rival.release();
			}
		});
	});

	describe("Stop of a recorded process", () => {
		const recorded = { slot: SLOT, brokerId: "broker-1", brokerGeneration: "gen-1" };
		it("stops a draft without a file and keeps the draft row, stopped, with its reserved identity released", async () => {
			const f = await legacyFixture("stop-draft", true, false);
			f.state.brokerSlots = { forget: async () => {} } as never;
			try {
				assert.equal(await f.actions.stopHost(f.state.context, f.index, TAB), true);
				assert.deepEqual(f.operations, ["stop legacy child and shutdown broker"]);
				const row = f.index.get(TAB);
				assert.ok(row, "Stop never forgets a row");
				assert.deepEqual([row.sessionFile, row.runIntent, row.host], [null, "stopped", null]);
				const seen = await f.index.observeOwnership(TAB);
				assert.ok(seen.ok && seen.claim === null, "the draft's reserved identity is released");
			} finally {
				await f.index.closeSession(TAB, { confirmedStopped: true });
			}
		});

		it("stops the recorded broker's process of a row another live window holds, and leaves that window's claim alone", async () => {
			const f = await legacyFixture("stop-held", true, true);
			const held = await holdAsAnotherWindow(f.index, f.root, f.file!);
			f.state.brokerSlots = { forget: async () => {} } as never;
			try {
				assert.equal(await f.actions.stopHost(f.state.context, f.index, TAB), true);
				assert.deepEqual(f.operations, ["stop legacy child and shutdown broker"], "a Stop is allowed against a rival's recorded broker, after the user's confirmation");
				assert.equal(f.dialogs.length, 1);
				assert.equal(await held.holder(), held.holderId, "the other window's claim is neither taken nor released");
			} finally {
				await held.rival.release();
			}
		});

		it("keeps the row's process, slot and credentials when the broker could not prove the writer gone", async () => {
			const f = await legacyFixture("stop-stuck", true, true);
			f.state.brokerSlots = { forget: async () => { throw new Error("must not be reached"); } } as never;
			f.state.outcomes.set(TAB, { status: "draft" });
			f.state.stopPort = { stopRecordedHost: async () => ({ kind: "stopped", writerGone: false, treeEmpty: false, detail: "OMP is still running.", slot: SLOT }) };
			try {
				assert.equal(await f.actions.stopHost(f.state.context, f.index, TAB), false);
				assert.equal(f.warnings.length, 1);
				assert.match(f.warnings[0]!, /OMP is still running\./);
				assert.deepEqual([f.state.outcomes.size, f.released], [1, []]);
				assert.ok(f.index.get(TAB)?.host, "the recorded process stays recorded: it may still run");
				assert.equal(f.dialogs.length, 1, "no second question and no forced stop from this path");
			} finally {
				await f.index.closeSession(TAB, { confirmedStopped: true });
			}
		});
	});

	describe("Delete", () => {
		it("refuses a row another live window holds, before any question, and keeps its transcript and claim", async () => {
			const f = await legacyFixture("delete-held", false, true);
			const held = await holdAsAnotherWindow(f.index, f.root, f.file!);
			try {
				assert.equal(await f.actions.confirmAndDelete(f.index, TAB), false);
				assert.deepEqual(f.dialogs, [], "nothing is confirmed that cannot be done");
				assert.equal(f.warnings.length, 1);
				assert.ok(await readFile(f.file!, "utf8"));
				assert.ok(f.index.get(TAB));
				assert.equal(await held.holder(), held.holderId);
			} finally {
				await held.rival.release();
			}
		});

		it("refuses a draft without a file, saying why, with no question", async () => {
			const f = await legacyFixture("delete-draft", false, false);
			assert.equal(await f.actions.confirmAndDelete(f.index, TAB), false);
			assert.deepEqual(f.dialogs, []);
			assert.equal(f.warnings.length, 1);
			assert.match(f.warnings[0]!, /^This session was not deleted: /);
			assert.ok(f.index.get(TAB), "the draft row is kept");
		});

		for (const [why, port] of [
			["it cannot be reached", { kind: "unknown", detail: "This session is disconnected. Reopen its editor and try Stop again." }],
			["it is not proven gone", { kind: "stopped", writerGone: false, treeEmpty: false, detail: "OMP is still running.", slot: SLOT }],
		] as const) {
			it(`deletes nothing when the running session's recorded process cannot be stopped because ${why}`, async () => {
				const f = await legacyFixture("delete-unstoppable", true, true);
				f.state.stopPort = { stopRecordedHost: async () => port } as RecordedHostStopPort;
				const before = await readFile(f.file!, "utf8");
				try {
					assert.equal(await f.actions.confirmAndDelete(f.index, TAB), false);
					assert.equal(f.dialogs.length, 1, "the one confirmation was asked; the stop it led to failed");
					assert.equal(await readFile(f.file!, "utf8"), before, "the transcript is untouched");
					assert.ok(f.index.get(TAB));
					assert.ok(f.warnings.length >= 1, "the user is told the session was not stopped");
					assert.deepEqual(f.forgotten, [], "no conversation state is dropped for a row that stays");
				} finally {
					await f.index.closeSession(TAB, { confirmedStopped: true });
				}
			});
		}
	});
});
