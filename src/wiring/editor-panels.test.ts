/**
 * The editor panels through their interface with fake dependencies: where a new session editor opens and what
 * happens when another editor already holds the conversation, how a panel becomes a chat surface, which document
 * a bound panel shows, how VS Code's revival of a versioned and of a legacy editor ends, and the chat-column
 * and composer-focus policies.
 *
 * Everything of the window (tab records, editor-slot elections, bridge host, launcher, conversation pages) is a
 * fake that records what it was asked; the editor coordinator is the real one-winner table; `vscode` is the
 * stand-in of `vscode-test-stub.ts`, so this file must run under `node --test`.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { beforeEach, describe, it } from "node:test";

import type { SessionIndex } from "../host/session-index.ts";
import { RuntimeRecords } from "../runtime/runtime-record.ts";
import type { BridgeTicketFacts } from "./bridge-host.ts";
import type { EditorPanels, EditorPanelsDeps, EditorPanelsTab } from "./editor-panels.ts";

// The module and the host modules it imports load the `vscode` specifier; map it before the first import.
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
const { EDITOR_TAB_ICON, UPDATED_ON_DISK_DETAIL, registerEditorPanels } = await import("./editor-panels.ts");
const { EditorCoordinator } = await import("../host/editor-coordinator.ts");
const { bridgeViewType, decodeBridgeViewType } = await import("../host/bridge-identity.ts");
const { URI } = await import("vscode-uri");

const TAB = "tab:11111111-2222-4333-8444-555555555555";
const EDITOR = "b".repeat(32);
const OTHER_EDITOR = "c".repeat(32);
const DOCUMENT = "d".repeat(32);
const BOOTSTRAP = "e".repeat(32);
const SLOT_REASONS = { passive: "passive-default", electing: "electing" };

type FakeTab = { -readonly [K in keyof EditorPanelsTab]: EditorPanelsTab[K] };

interface FakePanel {
	viewType: string;
	title: string;
	iconPath: unknown;
	active: boolean;
	viewColumn: number | undefined;
	disposed: boolean;
	reveals: unknown[][];
	posted: Record<string, unknown>[];
	htmlWrites: number;
	html: string;
	options: unknown;
	webview: { html: string; options: unknown; cspSource: string; asWebviewUri(uri: unknown): unknown; postMessage(message: Record<string, unknown>): Promise<boolean> };
	reveal(...args: unknown[]): void;
	dispose(): void;
	onDidChangeViewState(): { dispose(): void };
}

function fakePanel(viewType = "", viewColumn: number | undefined = 1): FakePanel {
	const panel: FakePanel = {
		viewType, title: "", iconPath: undefined, active: true, viewColumn, disposed: false, reveals: [], posted: [], htmlWrites: 0, html: "", options: undefined,
		webview: {
			get html() { return panel.html; },
			set html(value: string) { panel.html = value; panel.htmlWrites++; },
			get options() { return panel.options; },
			set options(value: unknown) { panel.options = value; },
			cspSource: "vscode-webview://fixture",
			asWebviewUri: uri => uri,
			postMessage: async message => { panel.posted.push(message); return true; },
		},
		reveal: (...args) => { panel.reveals.push(args); },
		dispose: () => { panel.disposed = true; },
		onDidChangeViewState: () => ({ dispose() {} }),
	};
	return panel;
}

const context = (): never => ({ extensionUri: URI.file("/ext") }) as never;

const newTab = (slotId: string, overrides: Partial<FakeTab> = {}): FakeTab => ({
	slotId, tabId: null, panel: null, mode: "chat", heldReadyReport: null, bridge: null, document: null, origin: null, ...overrides,
});

interface IndexFixture {
	readonly bound: [string, string, string][];
	readonly modes: [string, string][];
	readonly bindings: Map<string, { tabId: string; role: string; mode?: string }>;
	grant: { role: "controlling" | "passive"; tabId?: string; roleRefusal?: string };
	failBinding: boolean;
	entry: unknown;
	activeTabId: string | null;
}

function indexFixture(): SessionIndex & IndexFixture {
	const fixture: IndexFixture = { bound: [], modes: [], bindings: new Map(), grant: { role: "controlling" }, failBinding: false, entry: null, activeTabId: null };
	return Object.assign(fixture, {
		get: () => fixture.entry,
		slotBinding: (slot: string) => fixture.bindings.get(slot) ?? null,
		bindEditorSlot: async (slot: string, conversation: string, role: string) => {
			fixture.bound.push([slot, conversation, role]);
			if (fixture.failBinding) throw new Error("catalog write failed");
			return { slot, tabId: fixture.grant.tabId ?? conversation, ...fixture.grant };
		},
		setEditorMode: async (slot: string, mode: string) => { fixture.modes.push([slot, mode]); },
	}) as never;
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) {
		const turned = Promise.withResolvers<void>();
		setImmediate(turned.resolve);
		await turned.promise;
	}
}
const nextTurn = (): Promise<void> => {
	const turned = Promise.withResolvers<void>();
	setImmediate(turned.resolve);
	return turned.promise;
};

function world(overrides: Partial<EditorPanelsDeps<FakeTab>> = {}) {
	const state = {
		tabs: new Map<string, FakeTab>(),
		records: new RuntimeRecords(() => null),
		editors: new EditorCoordinator(),
		live: new Set<string>(),
		columns: new Map<string, number>(),
		waiters: new Map<string, Set<() => void>>(),
		drafts: new Map<string, unknown>(),
		sequence: 0,
		startupSettled: true,
		packageChanged: false,
		prepared: null as unknown,
		adopted: true,
		ticket: null as BridgeTicketFacts | null,
		endpointFailure: undefined as string | undefined,
		editorTab: null as unknown,
		revive: { selected: true, panel: null as unknown },
		carried: null as unknown,
		active: null as (FakeTab & { tabId: string; panel: never }) | null,
		sessionTabs: new Set<string>(),
		outcomesReplayed: [] as string[],
		defaultMode: "chat" as "chat" | "terminal",
		prepareDelay: null as Promise<void> | null,
	};
	const calls: string[] = [];
	const logged: string[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];
	const elections: Promise<void>[] = [];
	const created: { viewType: string; title: string; showOptions: unknown; options: unknown; panel: FakePanel }[] = [];
	const registered: string[] = [];
	const lifecycle: string[] = [];
	const routeOpens: string[] = [];
	const guestCalls: string[] = [];
	const deps: EditorPanelsDeps<FakeTab> = {
		records: () => state.records,
		tabs: () => state.tabs,
		tab: key => key === null ? undefined : state.tabs.get(key) ?? [...state.tabs.values()].find(candidate => candidate.tabId === key),
		tabState: key => {
			const existing = state.tabs.get(key) ?? [...state.tabs.values()].find(candidate => candidate.tabId === key);
			if (existing !== undefined) return existing;
			const created = newTab(key, /^[0-9a-f]{32}$/.test(key) ? {} : { tabId: key });
			state.tabs.set(key, created);
			return created;
		},
		editors: () => state.editors,
		liveEditors: () => state.live,
		nextEditorEvent: () => ++state.sequence,
		sessionPanelColumns: () => state.columns as never,
		panelBindWaiters: () => state.waiters,
		draftRestores: () => state.drafts as never,
		startupRestoreSettled: () => state.startupSettled,
		guest: () => ({
			carryDraftFrom: async previous => { guestCalls.push(`carry:${previous === null ? "none" : "panel"}`); return state.carried as never; },
			releaseCarriedDraft: carried => { guestCalls.push(`release:${carried === null ? "none" : "carried"}`); },
		}),
		routing: () => ({ openRestoredTabIfUncovered: async (_context, _index, tabId) => { routeOpens.push(tabId); } }),
		bridge: () => ({
			prepareDocument: async (_context, editorId) => {
				calls.push(`prepare:${editorId}`);
				await state.prepareDelay;
				return state.prepared as never;
			},
			adoptEditor: async (_context, slot) => { calls.push(`adopt:${slot}`); return state.adopted; },
			ticketFacts: () => state.ticket,
			registerSerializer: (_context, _index, viewType) => { registered.push(viewType); },
			offerRoute: tabId => { calls.push(`offer:${tabId}`); },
			endpointOf: () => state.endpointFailure === undefined ? null : ({ failure: state.endpointFailure }) as never,
		}),
		slotReasons: SLOT_REASONS,
		bindSlotToConversation: (slot, conversation, role, reason) => {
			calls.push(`bindSlot:${slot}:${role}:${reason}`);
			const tab = state.tabs.get(slot) ?? newTab(slot);
			tab.tabId = conversation;
			state.tabs.set(slot, tab);
			return tab;
		},
		trackElection: (_slot, work) => { elections.push(work); return work; },
		applySlotAuthority: slot => { calls.push(`authority:${slot}`); },
		reserveSlot: (_index, conversation, slot, provenance) =>
			state.editors.reserve({ tabId: conversation, editorId: slot, provenance, sequence: ++state.sequence }),
		defaultSessionMode: () => state.defaultMode,
		isSessionTab: key => /^[0-9a-f]{32}$/.test(key),
		applyChatTabAppearance: async (_context, _index, key) => { calls.push(`appearance:${key}`); },
		registerPanelLifecycle: (_index, slot) => { lifecycle.push(slot); },
		ensureTerminalPipeline: (_index, slot) => { calls.push(`pipeline:${slot}`); },
		forgetTerminalCopy: tab => { calls.push(`forgetCopy:${tab.slotId}`); },
		refreshGuestContext: () => { calls.push("refreshGuestContext"); },
		packageChangedOnDisk: () => state.packageChanged,
		replayPanelOutcome: (_index, tabId) => { state.outcomesReplayed.push(tabId); },
		createWebviewPanel: (viewType, title, showOptions, options) => {
			const panel = fakePanel(viewType, typeof showOptions === "number" ? showOptions : showOptions.viewColumn);
			panel.title = title;
			created.push({ viewType, title, showOptions, options, panel });
			// VS Code reports the new editor's tab in the group it was created in.
			const column = typeof showOptions === "number" ? showOptions : showOptions.viewColumn;
			const group = stub.window.tabGroups.all.find(candidate => candidate.viewColumn === column);
			if (group !== undefined) group.tabs.push({ label: title, input: new stub.TabInputWebview(viewType), group });
			return panel as never;
		},
		editorTabOf: () => state.editorTab as never,
		reviveEditorPanel: async () => { calls.push("revive"); return state.revive as never; },
		activePanelTab: () => state.active,
		refreshLauncher: () => { calls.push("refreshLauncher"); },
		setActiveTab: async (_index, tabId) => { calls.push(`setActive:${tabId}`); },
		requestSessionRowExpand: tabId => { calls.push(`expand:${tabId}`); },
		ensureCatalogReady: async () => { calls.push("catalogReady"); },
		log: message => { logged.push(message); },
		info: message => { infos.push(message); },
		warn: message => { warnings.push(message); },
		...overrides,
	};
	const panels: EditorPanels = registerEditorPanels(deps);
	return { state, panels, deps, calls, logged, warnings, infos, elections, created, registered, lifecycle, routeOpens, guestCalls };
}

const ticket = (port = 4242): BridgeTicketFacts => ({ editorId: EDITOR, documentId: DOCUMENT, bootstrapId: BOOTSTRAP, port });
const preparedDocument = (port = 4242) => ({ endpoint: {}, documentId: DOCUMENT, bootstrapId: BOOTSTRAP, port });

beforeEach(() => {
	stub.commands.calls.length = 0;
	stub.commands.handler = null;
	stub.window.tabGroups.all = [];
	stub.window.tabGroups.activeTabGroup = { viewColumn: 1, tabs: [], activeTab: undefined };
	stub.window.serializers.clear();
	stub.window.notices.length = 0;
	for (const key of Object.keys(stub.workspace.settings)) delete stub.workspace.settings[key];
});

/** A bound editor of the fake window: a record with a panel, as `bindPanel` leaves it. */
function boundEditor(w: { readonly state: { readonly tabs: Map<string, FakeTab> } }, slot = EDITOR, overrides: Partial<FakeTab> = {}): { tab: FakeTab; panel: FakePanel } {
	const panel = fakePanel(bridgeViewType(TAB, /^[0-9a-f]{32}$/.test(slot) ? slot : EDITOR));
	const tab = newTab(slot, { tabId: TAB, panel: panel as never, ...overrides });
	w.state.tabs.set(slot, tab);
	return { tab, panel };
}

describe("openPanel", () => {
	it("brings the editor a tab already has to the front and creates nothing", () => {
		const w = world();
		const { panel } = boundEditor(w, TAB);
		w.panels.openPanel(context(), indexFixture(), TAB);
		assert.equal(panel.reveals.length, 1);
		assert.equal(w.created.length, 0);
		assert.deepEqual(w.calls, []);
	});

	it("leaves a surviving bridged page alone: it is already this editor, whatever panel handle it lacks", () => {
		const w = world();
		const tab = newTab(TAB, { tabId: TAB, bridge: { editorId: EDITOR, endpoint: {} as never, documentId: DOCUMENT, bound: true } });
		w.state.tabs.set(TAB, tab);
		w.state.live.add(EDITOR);
		w.panels.openPanel(context(), indexFixture(), TAB);
		assert.equal(w.created.length, 0);
		assert.equal(w.state.editors.winner(TAB), null, "no rival editor is reserved for it");
	});

	it("shows the restored editor VS Code has not revived instead of opening a rival, and says so only when it cannot", async () => {
		const w = world();
		w.state.editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "saved", sequence: 1 });
		w.state.editorTab = { label: "restored" };
		w.panels.openPanel(context(), indexFixture(), TAB);
		await settle();
		assert.deepEqual(w.calls, ["revive"]);
		assert.deepEqual(w.warnings, [], "no \"already open\" warning without showing the tab");
		assert.equal(w.created.length, 0);

		w.state.revive = { selected: false, panel: null };
		w.panels.openPanel(context(), indexFixture(), TAB);
		await settle();
		assert.deepEqual(w.warnings, ["That OMP session is open in a tab VS Code could not bring to the front. Select its tab in the editor."]);
	});

	it("warns, and refreshes the launcher, when another editor holds the conversation and no tab shows it", () => {
		const w = world();
		w.state.editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "saved", sequence: 1 });
		w.panels.openPanel(context(), indexFixture(), TAB);
		assert.deepEqual(w.warnings, ["That OMP session is already open in this window."]);
		assert.deepEqual(w.calls, ["refreshLauncher"]);
		assert.equal(w.created.length, 0);
	});

	it("creates the editor under its own view type, registers its serializer, binds it and renders it once its document is prepared", async () => {
		const w = world();
		w.state.prepared = preparedDocument();
		w.state.ticket = ticket();
		const index = indexFixture();
		w.panels.openPanel(context(), index, TAB);
		assert.equal(w.created.length, 1);
		const [made] = w.created;
		const identity = decodeBridgeViewType(made!.viewType);
		assert.equal(identity?.tabId, TAB);
		const editorId = identity!.editorIdHex;
		assert.equal(w.state.editors.winner(TAB)?.editorId, editorId);
		assert.equal(w.state.editors.winner(TAB)?.provenance, "transient");
		assert.deepEqual(w.registered, [made!.viewType]);
		assert.equal(made!.title, "OMP Desk session", "the title is the row's headline once the row is known; bound later");
		assert.deepEqual(made!.options, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [URI.file("/ext/media")],
		});
		assert.ok(w.calls.includes(`bindSlot:${editorId}:passive:${SLOT_REASONS.electing}`), "the panel is published passive while its election is pending");
		assert.ok(w.calls.includes(`setActive:${TAB}`));
		await settle();
		assert.deepEqual(w.calls.filter(call => call.startsWith("prepare:")), [`prepare:${editorId}`]);
		assert.match(made!.panel.html, new RegExp(`connect-src http://127\\.0\\.0\\.1:4242 ws://127\\.0\\.0\\.1:4242`));
		assert.equal(w.state.tabs.get(editorId)?.document?.kind, "guest");
		assert.deepEqual(w.state.editors.winner(TAB)?.editorId, editorId);
	});

	it("names the editor for the session its row already shows", () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Fix the build", ordinal: 3 };
		w.panels.openPanel(context(), index, TAB);
		assert.equal(w.created[0]!.title, "Fix the build");
	});

	it("opens in the column a Chat /new asked for, once, and does not arrange a group", async () => {
		const w = world();
		w.state.columns.set(TAB, 2);
		w.panels.openPanel(context(), indexFixture(), TAB);
		assert.equal(w.created[0]!.showOptions, 2);
		assert.equal(w.state.columns.has(TAB), false, "the hint is consumed");
		await settle();
		assert.deepEqual(stub.commands.calls, []);
		assert.equal(w.logged.some(line => line.startsWith("chat column:")), false);
	});

	it("keeps the active column when ompDesk.chatColumn is off", () => {
		stub.workspace.settings["ompDesk.chatColumn"] = false;
		const w = world();
		w.panels.openPanel(context(), indexFixture(), TAB);
		assert.equal(w.created[0]!.showOptions, stub.ViewColumn.Active);
		assert.equal(w.logged.some(line => line.startsWith("chat column:")), false);
	});

	it("joins the chat group that holds a session editor and locks it", async () => {
		const w = world();
		const chat = { viewColumn: 2, tabs: [] as never[], activeTab: undefined };
		const files = { viewColumn: 1, tabs: [] as never[], activeTab: undefined };
		chat.tabs.push({ label: "chat", input: new stub.TabInputWebview(bridgeViewType(TAB.replace("1111", "2222"), OTHER_EDITOR)), group: chat } as never);
		stub.window.tabGroups.all = [files, chat] as never;
		stub.window.tabGroups.activeTabGroup = chat as never;
		w.panels.openPanel(context(), indexFixture(), TAB);
		assert.equal(w.created[0]!.showOptions, 2);
		assert.ok(w.logged.includes("chat column: session editor placed at column 2 (lock)"));
		for (let turn = 0; turn < 20 && !stub.commands.calls.some(call => call[0] === "workbench.action.lockEditorGroup"); turn++) await nextTurn();
		assert.deepEqual(stub.commands.calls, [["workbench.action.lockEditorGroup"]]);
	});

	it("renders the panel without a bridge when its endpoint could not be provided, and clears the half-made binding", async () => {
		const w = world();
		w.state.prepared = null;
		w.state.endpointFailure = "port in use";
		w.panels.openPanel(context(), indexFixture(), TAB);
		const editorId = decodeBridgeViewType(w.created[0]!.viewType)!.editorIdHex;
		w.state.tabs.get(editorId)!.bridge = { editorId, endpoint: {} as never, documentId: null, bound: false };
		await settle();
		assert.ok(w.logged.includes(`slot ${editorId}: this editor has no bridge endpoint (port in use)`));
		assert.equal(w.state.tabs.get(editorId)!.bridge, null);
		assert.match(w.created[0]!.panel.html, /connect-src 'none'/);
		assert.equal(w.state.tabs.get(editorId)!.document?.kind, "guest");
	});

	it("does not render a document for a panel the slot no longer holds", async () => {
		const w = world();
		const prepareDelay = Promise.withResolvers<void>();
		w.state.prepareDelay = prepareDelay.promise;
		w.state.prepared = preparedDocument();
		w.panels.openPanel(context(), indexFixture(), TAB);
		const editorId = decodeBridgeViewType(w.created[0]!.viewType)!.editorIdHex;
		const written = w.created[0]!.panel.htmlWrites;
		w.state.tabs.get(editorId)!.panel = fakePanel() as never;
		prepareDelay.resolve();
		await settle();
		assert.equal(w.created[0]!.panel.htmlWrites, written, "the document the bind installed is the last one it wrote");
	});
});

describe("bindPanel", () => {
	it("publishes the panel passive while its election is pending, then as controlling once the index grants it", async () => {
		const w = world();
		const index = indexFixture();
		const panel = fakePanel(bridgeViewType(TAB, EDITOR));
		w.panels.bindPanel(context(), index, EDITOR, TAB, panel as never, "created");
		assert.deepEqual(index.bound, [[EDITOR, TAB, "controlling"]]);
		assert.equal(w.state.tabs.get(EDITOR)?.panel, panel);
		assert.equal(w.state.tabs.get(EDITOR)?.origin, "created");
		assert.equal(w.state.tabs.get(EDITOR)?.document?.kind, "guest", "a panel with no bridge at all still gets its chat document at once");
		index.bindings.set(EDITOR, { tabId: TAB, role: "controlling" });
		await Promise.all(w.elections);
		assert.deepEqual(w.calls.filter(call => call.startsWith("bindSlot") || call.startsWith("authority")), [
			`bindSlot:${EDITOR}:passive:${SLOT_REASONS.electing}`,
			`bindSlot:${EDITOR}:controlling:null`,
			`authority:${EDITOR}`,
		]);
		assert.deepEqual(index.modes, [[EDITOR, "chat"]], "the view mode is recorded after the role is published");
		assert.ok(w.calls.includes(`appearance:${EDITOR}`));
		assert.deepEqual(w.lifecycle, [EDITOR]);
	});

	it("publishes the passive surface it really is when the index refuses control, and says why", async () => {
		const w = world();
		const index = indexFixture();
		index.grant = { role: "passive", roleRefusal: "another window holds the writer" };
		index.bindings.set(EDITOR, { tabId: TAB, role: "passive" });
		w.panels.bindPanel(context(), index, EDITOR, TAB, fakePanel() as never, "created");
		await Promise.all(w.elections);
		assert.ok(w.calls.includes("bindSlot:" + EDITOR + ":passive:another window holds the writer"));
		assert.ok(w.logged.includes(`slot ${EDITOR}: this editor is not controlling ${TAB} (another window holds the writer)`));
		assert.deepEqual(w.calls.filter(call => call === `authority:${EDITOR}`).length, 1);
	});

	it("publishes a passive role with the default reason and does not wait for a grant", () => {
		const w = world();
		w.panels.bindPanel(context(), indexFixture(), EDITOR, TAB, fakePanel() as never, "created", "passive");
		assert.ok(w.calls.includes(`bindSlot:${EDITOR}:passive:${SLOT_REASONS.passive}`));
	});

	it("reports an election that could not be persisted instead of losing it", async () => {
		const w = world();
		const index = indexFixture();
		index.failBinding = true;
		w.panels.bindPanel(context(), index, EDITOR, TAB, fakePanel() as never, "created");
		await Promise.all(w.elections);
		assert.ok(w.logged.includes(`slot ${EDITOR}: its editor-slot binding could not be persisted (catalog write failed)`));
	});

	it("does not apply a grant to an editor that has meanwhile moved to another conversation", async () => {
		const w = world();
		const index = indexFixture();
		w.panels.bindPanel(context(), index, EDITOR, TAB, fakePanel() as never, "created");
		w.state.tabs.get(EDITOR)!.tabId = "tab:99999999-2222-4333-8444-555555555555";
		await Promise.all(w.elections);
		assert.equal(w.calls.some(call => call.startsWith("authority:")), false);
		assert.deepEqual(index.modes, []);
	});

	it("takes a restored editor's mode from its runtime, then its slot binding, then the default, and lets its page run scripts", () => {
		const index = indexFixture();
		const w = world();
		w.state.defaultMode = "terminal";
		w.panels.bindPanel(context(), index, EDITOR, TAB, fakePanel() as never, "restored");
		assert.equal(w.state.tabs.get(EDITOR)!.mode, "terminal", "the default when nothing else is known");

		index.bindings.set(OTHER_EDITOR, { tabId: TAB, role: "controlling", mode: "chat" });
		const second = fakePanel();
		w.panels.bindPanel(context(), index, OTHER_EDITOR, TAB, second as never, "restored");
		assert.equal(w.state.tabs.get(OTHER_EDITOR)!.mode, "chat", "the recorded slot binding wins over the default");
		assert.deepEqual(second.options, { enableScripts: true, localResourceRoots: [URI.file("/ext/media")] });

		const third = "d".repeat(31) + "e";
		w.state.tabs.set(third, newTab(third));
		w.state.records.acquire(TAB, third).runtime = { kind: "terminal", handle: {} } as never;
		w.panels.bindPanel(context(), index, third, TAB, fakePanel() as never, "restored");
		assert.equal(w.state.tabs.get(third)!.mode, "terminal");
		assert.ok(w.calls.includes(`pipeline:${third}`), "a terminal runtime gets its pipeline");
	});

	it("adopts the bridge editor the record already names, resets the document and wakes the callers waiting for the panel", () => {
		const w = world();
		const tab = newTab(EDITOR, { tabId: TAB, bridge: { editorId: EDITOR, endpoint: { scope: { tabId: TAB } } as never, documentId: null, bound: false }, document: { kind: "guest", bridgeDocumentId: null } });
		w.state.tabs.set(EDITOR, tab);
		let woken = 0;
		w.state.waiters.set(EDITOR, new Set([() => { woken++; }, () => { woken++; }]));
		w.panels.bindPanel(context(), indexFixture(), EDITOR, TAB, fakePanel() as never, "created");
		assert.ok(w.calls.includes(`adopt:${EDITOR}`));
		assert.equal(woken, 2);
		assert.ok(w.calls.includes("refreshLauncher"));
		assert.equal(tab.document?.kind, "unavailable", "a panel whose bridge ticket is not ready yet shows the explanation first");
	});
});

describe("renderPanelDocument", () => {
	it("shows the explanation while the bridge endpoint the document needs does not exist yet", () => {
		const w = world();
		const { tab, panel } = boundEditor(w, EDITOR, { bridge: { editorId: EDITOR, endpoint: { scope: { tabId: TAB } } as never, documentId: null, bound: false } });
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.equal(tab.document?.kind, "unavailable");
		assert.match(panel.html, /still connecting to OMP/);
		assert.equal(w.calls.some(call => call.startsWith("offer:")), false);
		assert.deepEqual(panel.iconPath, URI.file(`/ext/${EDITOR_TAB_ICON}`));
	});

	it("builds the guest document naming the exact bridge port, offers its route, and does not reload an unchanged document", () => {
		const w = world();
		const { tab, panel } = boundEditor(w, EDITOR, { bridge: { editorId: EDITOR, endpoint: { scope: { tabId: TAB } } as never, documentId: DOCUMENT, bound: false } });
		w.state.ticket = ticket(5151);
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.deepEqual(tab.document, { kind: "guest", bridgeDocumentId: DOCUMENT });
		assert.match(panel.html, /connect-src http:\/\/127\.0\.0\.1:5151 ws:\/\/127\.0\.0\.1:5151/);
		assert.match(panel.html, /omp-session-mode" content="chat"/);
		assert.deepEqual(w.calls.filter(call => !call.startsWith("forgetCopy")), ["refreshGuestContext", `offer:${EDITOR}`]);
		assert.equal(panel.htmlWrites, 1);
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.equal(panel.htmlWrites, 1, "assigning webview.html reloads the page, so an unchanged document is left alone");
		assert.deepEqual(w.calls.filter(call => call.startsWith("offer:")), [`offer:${EDITOR}`]);
	});

	it("builds the explanation's identity from the editor's own view type, and the terminal icon for a terminal editor", () => {
		const w = world();
		const { panel } = boundEditor(w, EDITOR, { mode: "terminal" });
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.deepEqual(panel.iconPath, URI.file("/ext/media/terminal-icon.svg"));
		assert.match(panel.html, /omp-session-mode" content="terminal"/);
	});

	it("replaces the document when the bridge ticket appears, and forgets the screen copy the old one had asked for", () => {
		const w = world();
		const { tab, panel } = boundEditor(w, EDITOR, { bridge: { editorId: EDITOR, endpoint: { scope: { tabId: TAB } } as never, documentId: null, bound: false } });
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.equal(tab.document?.kind, "unavailable");
		tab.bridge!.documentId = DOCUMENT;
		w.state.ticket = ticket();
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.equal(tab.document?.kind, "guest");
		assert.equal(panel.htmlWrites, 2);
		assert.deepEqual(w.calls.filter(call => call.startsWith("forgetCopy")), [`forgetCopy:${EDITOR}`, `forgetCopy:${EDITOR}`]);
	});

	it("withholds a document it would build from a replaced bundle, but never reloads the page that is already loaded", () => {
		const w = world();
		w.state.packageChanged = true;
		const { tab, panel } = boundEditor(w, EDITOR);
		w.panels.renderPanelDocument(context(), EDITOR);
		assert.equal(tab.document?.kind, "unavailable");
		assert.ok(panel.html.includes(UPDATED_ON_DISK_DETAIL));
		assert.match(panel.html, /id="reload"/);

		const loaded = boundEditor(w, OTHER_EDITOR, { bridge: { editorId: OTHER_EDITOR, endpoint: { scope: { tabId: TAB } } as never, documentId: DOCUMENT, bound: true }, document: { kind: "guest", bridgeDocumentId: DOCUMENT } });
		w.state.ticket = ticket();
		w.panels.renderPanelDocument(context(), OTHER_EDITOR);
		assert.equal(loaded.panel.htmlWrites, 0);
		assert.equal(loaded.tab.document?.kind, "guest");
	});

	it("ignores a folder shell, an editor with no conversation and an editor with no panel", () => {
		const w = world();
		const shell = newTab("shell-slot", { panel: fakePanel() as never });
		w.state.tabs.set("shell-slot", shell);
		w.panels.renderPanelDocument(context(), "shell-slot");
		const bare = newTab(EDITOR, { tabId: TAB });
		w.state.tabs.set(EDITOR, bare);
		w.panels.renderPanelDocument(context(), EDITOR);
		w.panels.renderPanelDocument(context(), "unknown");
		assert.equal(shell.document, null);
		assert.equal(bare.document, null);
		assert.deepEqual(w.calls, []);
	});
});

describe("the versioned serializer", () => {
	const viewType = bridgeViewType(TAB, EDITOR);
	const state = { version: 2, tabId: TAB, editorId: EDITOR };

	it("waits for the catalog and gives an editor an icon before it decides anything", async () => {
		const w = world();
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), indexFixture(), viewType).deserializeWebviewPanel(panel as never, { version: 1 });
		assert.deepEqual(panel.iconPath, URI.file(`/ext/${EDITOR_TAB_ICON}`));
		assert.equal(w.calls[0], "catalogReady");
	});

	it("leaves a restored editor whose state does not prove its view type as an explanation, and binds nothing", async () => {
		const w = world();
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), indexFixture(), viewType).deserializeWebviewPanel(panel as never, { version: 2, tabId: TAB, editorId: OTHER_EDITOR });
		assert.match(panel.html, /does not recognize which session it belonged to/);
		assert.ok(w.logged.includes("a restored OMP editor carried no usable bridge identity; it was left as an explanation"));
		assert.equal(w.state.tabs.size, 0);
		assert.equal(w.state.editors.winner(TAB), null);
	});

	it("says the state was a legacy version-1 identity the view type and binding did not prove", async () => {
		const w = world();
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), indexFixture(), viewType).deserializeWebviewPanel(panel as never, { version: 1, tabId: TAB });
		assert.ok(w.logged.some(line => line.includes("legacy version-1 identity that its view type and durable controlling binding do not prove")));
	});

	it("adopts a legacy version-1 identity only when the view type and the durable controlling binding prove the pair", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		index.bindings.set(EDITOR, { tabId: TAB, role: "controlling" });
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(panel as never, { version: 1, tabId: TAB });
		assert.ok(w.logged.includes(`slot ${EDITOR.slice(0, 8)}: a legacy version-1 identity was adopted because this editor's view type and durable controlling binding proved it`));
		assert.equal(w.state.tabs.get(EDITOR)?.panel, panel);
	});

	it("leaves an editor for a row this workspace no longer has as an explanation", async () => {
		const w = world();
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), indexFixture(), viewType).deserializeWebviewPanel(panel as never, state);
		assert.match(panel.html, /no longer in the Sessions view/);
		assert.ok(w.logged.includes("a restored OMP editor named a tab this workspace no longer has; it was left as an explanation"));
		assert.equal(w.state.tabs.size, 0);
	});

	it("serves the conversation the durable binding names now, not the namespace the view type was minted under", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		const moved = "tab:99999999-2222-4333-8444-555555555555";
		index.bindings.set(EDITOR, { tabId: moved, role: "controlling" });
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(panel as never, state);
		assert.equal(w.state.tabs.get(EDITOR)?.tabId, moved);
		assert.equal(w.state.editors.winner(moved)?.editorId, EDITOR);
	});

	it("closes a second restored editor of a conversation another saved editor already holds", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		w.state.editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "saved", sequence: 1 });
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(panel as never, state);
		assert.equal(panel.disposed, true);
		assert.deepEqual(w.infos, ["An OMP Desk editor restored for this window was closed: it was a duplicate of one already open for the same session."]);
		assert.ok(w.logged.includes(`slot ${EDITOR}: a second restored webview for this conversation was closed`));
		assert.equal(w.state.tabs.size, 0);
	});

	it("binds a restored editor with the committed role, renders it, and hands the page the conversation's outcome", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		index.bindings.set(EDITOR, { tabId: TAB, role: "passive" });
		w.state.prepared = preparedDocument();
		w.state.ticket = ticket();
		const panel = fakePanel(viewType);
		panel.active = false;
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(panel as never, state);
		assert.deepEqual(index.bound, [[EDITOR, TAB, "passive"]]);
		assert.ok(w.calls.includes(`bindSlot:${EDITOR}:passive:${SLOT_REASONS.passive}`));
		assert.ok(w.calls.includes(`adopt:${EDITOR}`));
		assert.ok(w.calls.includes(`prepare:${EDITOR}`));
		assert.equal(w.state.tabs.get(EDITOR)?.document?.kind, "guest");
		assert.deepEqual(w.state.outcomesReplayed, [TAB]);
		assert.deepEqual(w.routeOpens, [TAB]);
		assert.equal(w.calls.some(call => call.startsWith("setActive:")), false, "only an editor VS Code made active describes the user's selection");
	});

	it("renders a restored editor without a bridge when the endpoint cannot be provided, and follows the active selection", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		w.state.prepared = null;
		const panel = fakePanel(viewType);
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(panel as never, state);
		assert.ok(w.logged.includes(`slot ${EDITOR}: restored editor has no reconnect bridge; serving its chat through the panel`));
		assert.equal(w.state.tabs.get(EDITOR)?.document?.kind, "guest");
		assert.ok(w.calls.includes(`expand:${TAB}`), "the row of an active restored editor is expanded once startup is over");
		assert.ok(w.calls.includes(`setActive:${TAB}`));
	});

	it("does not expand the row while the startup pass is still running", async () => {
		const w = world();
		w.state.startupSettled = false;
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(fakePanel(viewType) as never, state);
		assert.equal(w.calls.some(call => call.startsWith("expand:")), false);
		assert.ok(w.calls.includes(`setActive:${TAB}`));
	});

	it("carries the unsent draft of the transient panel it replaces, and releases the handoff however binding ends", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		const transient = fakePanel();
		w.state.tabs.set(TAB, newTab(TAB, { tabId: TAB, panel: transient as never }));
		w.state.editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "transient", sequence: 1 });
		w.state.carried = { reply: { requestId: 7 } };
		await w.panels.bridgeSerializerFor(context(), index, viewType).deserializeWebviewPanel(fakePanel(viewType) as never, state);
		assert.deepEqual(w.guestCalls, ["carry:panel", "release:carried"]);
		assert.equal(w.state.drafts.get(EDITOR), w.state.carried);
		assert.equal(transient.disposed, true);
		assert.equal(w.state.editors.winner(TAB)?.editorId, EDITOR);
	});
});

describe("the legacy serializer", () => {
	it("leaves a panel with no usable identity as an explanation", async () => {
		const w = world();
		const panel = fakePanel("omp.session");
		await w.panels.legacySerializerFor(context(), indexFixture()).deserializeWebviewPanel(panel as never, { version: 9 });
		assert.match(panel.html, /does not recognize which session it belonged to/);
		assert.ok(w.logged.includes("a restored OMP editor carried no usable panel identity; it was left as an explanation"));
		assert.equal(w.created.length, 0);
	});

	it("leaves a panel for a row this workspace no longer has as an explanation", async () => {
		const w = world();
		const panel = fakePanel("omp.session");
		await w.panels.legacySerializerFor(context(), indexFixture()).deserializeWebviewPanel(panel as never, { version: 1, tabId: TAB });
		assert.match(panel.html, /no longer in the Sessions view/);
		assert.equal(w.created.length, 0);
	});

	it("keeps its own editor and explains itself when another editor already serves the conversation", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		w.state.editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "saved", sequence: 1 });
		const panel = fakePanel("omp.session");
		await w.panels.legacySerializerFor(context(), index).deserializeWebviewPanel(panel as never, { version: 1, tabId: TAB });
		assert.match(panel.html, /left as a note instead of starting a second copy/);
		assert.equal(panel.disposed, false);
		assert.equal(w.created.length, 0);
		assert.ok(w.logged.includes(`tab ${TAB}: a legacy panel was left as an explanation because another editor already owns this conversation`));
	});

	it("migrates onto one versioned successor in its own column, binds it before it disposes the source, and renders it", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Fix the build", ordinal: 1 };
		w.state.prepared = preparedDocument();
		w.state.ticket = ticket();
		const source = fakePanel("omp.session", 3);
		source.active = false;
		await w.panels.legacySerializerFor(context(), index).deserializeWebviewPanel(source as never, { version: 1, tabId: TAB });
		assert.equal(source.title, "Fix the build");
		assert.equal(w.created.length, 1);
		const made = w.created[0]!;
		assert.deepEqual(made.showOptions, { viewColumn: 3, preserveFocus: true }, "an unfocused source keeps the focus");
		const editorId = decodeBridgeViewType(made.viewType)!.editorIdHex;
		assert.deepEqual(w.registered, [made.viewType]);
		assert.equal(w.state.tabs.get(editorId)?.panel, made.panel);
		assert.equal(w.state.tabs.get(editorId)?.origin, "restored");
		assert.equal(source.disposed, true);
		assert.equal(w.state.editors.winner(TAB)?.editorId, editorId);
		assert.notEqual(w.state.editors.claimTransition(TAB, editorId), null, "the migration's ticket was settled, so a later one can be claimed");
		assert.equal(w.state.tabs.get(editorId)?.document?.kind, "guest");
		assert.ok(w.logged.includes(`tab ${TAB}: a legacy editor was migrated onto a versioned successor`));
		assert.deepEqual(w.state.outcomesReplayed, [TAB]);
	});

	it("carries the draft of a transient panel standing for the tab and disposes both predecessors", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		const transient = fakePanel();
		w.state.tabs.set(TAB, newTab(TAB, { tabId: TAB, panel: transient as never }));
		w.state.carried = { reply: { requestId: 9 } };
		const source = fakePanel("omp.session");
		await w.panels.legacySerializerFor(context(), index).deserializeWebviewPanel(source as never, { version: 1, tabId: TAB });
		const editorId = decodeBridgeViewType(w.created[0]!.viewType)!.editorIdHex;
		assert.deepEqual(w.guestCalls, ["carry:panel", "release:carried"]);
		assert.equal(w.state.drafts.get(editorId), w.state.carried);
		assert.equal(source.disposed, true);
		assert.equal(transient.disposed, true);
		assert.ok(w.logged.includes(`tab ${TAB}: a restored webview replaced the panel an explicit open had created`));
	});

	it("follows the selection when the migrated source was the active editor", async () => {
		const w = world();
		const index = indexFixture();
		index.entry = { title: "Session", ordinal: 1 };
		await w.panels.legacySerializerFor(context(), index).deserializeWebviewPanel(fakePanel("omp.session") as never, { version: 1, tabId: TAB });
		assert.ok(w.calls.includes(`setActive:${TAB}`));
	});
});

describe("session editor placement", () => {
	it("recognizes a tab input that shows a session editor, with or without the workbench prefix", () => {
		const w = world();
		const viewType = bridgeViewType(TAB, EDITOR);
		assert.equal(w.panels.isSessionTabInput(new stub.TabInputWebview(viewType)), true);
		assert.equal(w.panels.isSessionTabInput(new stub.TabInputWebview(`mainThreadWebview-${viewType}`)), true);
		assert.equal(w.panels.isSessionTabInput(new stub.TabInputWebview("omp.other")), false);
		assert.equal(w.panels.isSessionTabInput(new stub.TabInputText(URI.file("/a.ts"))), false);
		assert.equal(w.panels.isSessionTabInput(null), false);
	});

	it("reports the column VS Code shows a session editor in, not the one that was asked for", () => {
		const w = world();
		const viewType = bridgeViewType(TAB, EDITOR);
		const first = { viewColumn: 1, tabs: [] as never[], activeTab: undefined };
		const second = { viewColumn: 2, tabs: [] as never[], activeTab: undefined };
		second.tabs.push({ label: "chat", input: new stub.TabInputWebview(viewType), group: second } as never);
		stub.window.tabGroups.all = [first, second] as never;
		assert.equal(w.panels.sessionTabColumn(viewType), 2);
		assert.equal(w.panels.sessionTabColumn(bridgeViewType(TAB, OTHER_EDITOR)), undefined);
	});
});

describe("focusChatComposer", () => {
	it("opens the OMP Desk side bar when no session editor is open", async () => {
		const w = world();
		const index = indexFixture();
		index.activeTabId = null;
		await w.panels.focusChatComposer(index);
		assert.deepEqual(stub.commands.calls, [["workbench.view.extension.ompDesk"]]);
	});

	it("focuses the composer of the active session editor's page, revealing it without taking the group", async () => {
		const w = world();
		const { tab, panel } = boundEditor(w);
		w.state.active = tab as never;
		w.state.revive = { selected: true, panel };
		await w.panels.focusChatComposer(indexFixture());
		assert.deepEqual(panel.reveals, [[1, false]]);
		assert.deepEqual(panel.posted, [{ type: "omp:webview-action", action: "focus-composer" }]);
		assert.ok(w.logged.some(line => line.startsWith(`tab ${TAB}: focus-composer asked from a VS Code command or keybinding (delivered=true`)));
	});

	it("reveals a Terminal-mode editor and sends its page nothing", async () => {
		const w = world();
		const { tab, panel } = boundEditor(w, EDITOR, { mode: "terminal" });
		w.state.active = tab as never;
		w.state.revive = { selected: true, panel };
		await w.panels.focusChatComposer(indexFixture());
		assert.equal(panel.reveals.length, 1);
		assert.deepEqual(panel.posted, []);
	});

	it("falls back to the index's active session and revives its tab when VS Code restored it but never showed it", async () => {
		const w = world();
		const index = indexFixture();
		index.activeTabId = TAB;
		const { panel } = boundEditor(w);
		let revived: string | null = null;
		const revivingWorld = world({
			tab: key => w.deps.tab(key),
			reviveEditorPanel: async (_index, tabId) => { revived = tabId; return { selected: true, panel: panel as never }; },
		});
		await revivingWorld.panels.focusChatComposer(index);
		assert.equal(revived, TAB);
		assert.deepEqual(panel.posted, [{ type: "omp:webview-action", action: "focus-composer" }]);
	});
});
