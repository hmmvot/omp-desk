/**
 * The bridge host through its interface with fake dependencies: which editor and document may act, how an editor's
 * endpoint and document are provisioned, how the window's editors are reconciled with VS Code's membership, how a
 * page's reported origin is pinned and committed against the verified chat host, how the secret is delivered and
 * the route offered and acknowledged, and how the bridge of a closed editor is retired.
 *
 * The endpoint-provisioning cases bind a real `BridgeEditorEndpoint` on loopback with records in a temporary
 * directory; every other case gives the editors a fake endpoint that records what it was asked. Every case runs the
 * host's own endpoint creation (single-flight, scope check, registration, the bind outcome): only the environmental
 * `createEndpoint` port is faked, and an editor with no fake provided gets an endpoint whose listener cannot bind. The
 * editor coordinator is the real one-winner table; `vscode` is the stand-in of `vscode-test-stub.ts`, so this file
 * must run under `node --test`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import module from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import type { BridgeEditorEndpoint, BridgeEditorEndpointOptions } from "../host/bridge-endpoint.ts";
import type { BridgeNativeBinding } from "../host/bridge-records.ts";
import type { SessionIndex } from "../host/session-index.ts";
import { RuntimeRecords } from "../runtime/runtime-record.ts";
import type { ConversationRecord } from "../runtime/runtime-record.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import type { BridgeHost, BridgeHostDeps, BridgeTab } from "./bridge-host.ts";

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
const { registerBridgeHost } = await import("./bridge-host.ts");
const { EditorCoordinator } = await import("../host/editor-coordinator.ts");
const { bridgeViewType } = await import("../host/bridge-identity.ts");
const { encodeHex } = await import("../protocol/bridge-protocol.ts");
const { BridgeEditorEndpoint: RealEndpoint } = await import("../host/bridge-endpoint.ts");

const realEndpoint = (options: BridgeEditorEndpointOptions): BridgeEditorEndpoint => new RealEndpoint(options);

const TAB = "tab:11111111-2222-4333-8444-555555555555";
const OTHER_TAB = "tab:99999999-2222-4333-8444-555555555555";
const EDITOR = "b".repeat(32);
const OTHER_EDITOR = "c".repeat(32);
const DOCUMENT = "d".repeat(32);
const NEXT_DOCUMENT = "e".repeat(32);
const BOOTSTRAP = "f".repeat(32);
const ORIGIN = "vscode-webview://0r42vg5knjjkub1td6sq2sg4ggjt4ovjpvcnij5lj62f9k001mi3";

type FakeTab = { -readonly [K in keyof BridgeTab]: BridgeTab[K] };

interface FakeRoute {
	routeGeneration: string | null;
	acknowledged: boolean;
	dispatchable: boolean;
	statusWord: string;
	acknowledgedKinds: string[];
	status(): string;
	acknowledge(routeGeneration: string, kind: string): boolean;
}

function fakeRoute(routeGeneration: string | null = "r".repeat(32)): FakeRoute {
	const route: FakeRoute = {
		routeGeneration, acknowledged: false, dispatchable: true, statusWord: "ready", acknowledgedKinds: [],
		status: () => route.statusWord,
		acknowledge: (generation, kind) => {
			if (generation !== route.routeGeneration) return false;
			route.acknowledged = true;
			route.acknowledgedKinds.push(kind);
			return true;
		},
	};
	return route;
}

/** An endpoint that records what the host asked of it and answers from fields the cases set. */
class FakeEndpoint {
	readonly calls: string[] = [];
	readonly scope: { workspace: string; tabId: string; editorId: string };
	port: number | null = 4747;
	failure: string | null = null;
	document: { documentId: string; bootstrapId: string; route: FakeRoute } | null = null;
	route: FakeRoute | null = fakeRoute();
	nextDocument = NEXT_DOCUMENT;
	recorded: { documentId: string; bootstrapId: string; route: FakeRoute } | null = null;
	pinned = true;
	commitDelivery: unknown = null;
	redelivery: unknown = null;
	committed: BridgeNativeBinding | null = null;
	committedHash: string | null = null;
	beginDocumentFails = false;
	binds = 0;
	closes = 0;
	/** Runs while the host awaits this endpoint's bind. */
	onBind: (() => void) | null = null;
	constructor(editorId = EDITOR, tabId = TAB) {
		this.scope = { workspace: "a".repeat(64), tabId, editorId };
	}
	panelBound(): void { this.calls.push("panelBound"); }
	async bind(): Promise<number | null> { this.binds++; this.onBind?.(); return this.port; }
	close(): void { this.closes++; }
	async beginDocument(documentId: string, bootstrapId: string) {
		this.calls.push(`beginDocument:${documentId}`);
		if (this.beginDocumentFails) return null;
		this.document = { documentId, bootstrapId, route: this.route ?? fakeRoute() };
		return this.document;
	}
	async retireDocument(documentId: string): Promise<void> { this.calls.push(`retireDocument:${documentId}`); }
	async forget(): Promise<void> { this.calls.push("forget"); }
	async adoptRecordedDocument() { this.calls.push("adoptRecordedDocument"); return this.recorded; }
	offerBridge(): string | null { this.calls.push("offerBridge"); return "bridge-generation"; }
	offerPanel(): string | null { this.calls.push("offerPanel"); return this.route?.routeGeneration ?? null; }
	refreshBridgeOffer(): string | null { this.calls.push("refreshBridgeOffer"); return null; }
	pinOrigin(documentId: string, origin: string): boolean { this.calls.push(`pinOrigin:${documentId}:${origin}`); return this.pinned; }
	async commit(binding: BridgeNativeBinding) { this.calls.push(`commit:${binding.sessionId}`); return this.commitDelivery; }
	async delivery() { this.calls.push("delivery"); return this.redelivery; }
	committedBinding(): BridgeNativeBinding | null { return this.committed; }
	committedBindingHash(): string | null { return this.committedHash; }
	nativeReady(ready: boolean): void { this.calls.push(`nativeReady:${ready}`); }
	routeFor(documentId: string): FakeRoute | null {
		return this.document?.documentId === documentId ? this.document.route : this.route;
	}
}

function fakePanel() {
	const posted: Record<string, unknown>[] = [];
	return { posted, webview: { postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; } } };
}

const newTab = (slotId: string, overrides: Partial<FakeTab> = {}): FakeTab => ({
	slotId, tabId: null, panel: null, mode: "chat", heldReadyReport: null, bridge: null, ...overrides,
});

const nextTurn = (): Promise<void> => {
	const turned = Promise.withResolvers<void>();
	setImmediate(turned.resolve);
	return turned.promise;
};
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await nextTurn();
}

const secrets = (): { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> } => {
	const values = new Map<string, string>();
	return {
		get: async key => values.get(key),
		store: async (key, value) => { values.set(key, value); },
		delete: async key => { values.delete(key); },
	};
};

/** The records of the real endpoints of the provisioning cases live under one temporary directory. */
const root = await mkdtemp(path.join(tmpdir(), "bridge-host-test-"));
const endpoints: BridgeEditorEndpoint[] = [];

after(async () => {
	for (const endpoint of endpoints) endpoint.close();
	await rm(root, { recursive: true, force: true });
});

const context = (name: string): never =>
	({ globalStorageUri: { fsPath: path.join(root, name) }, secrets: secrets(), subscriptions: [] as { dispose(): void }[] }) as never;

function world(overrides: Partial<BridgeHostDeps<FakeTab>> = {}) {
	const state = {
		tabs: new Map<string, FakeTab>(),
		editors: new EditorCoordinator(),
		endpoints: new Map<string, BridgeEditorEndpoint>(),
		live: new Set<string>(),
		passive: new Map<string, string>(),
		index: null as Pick<SessionIndex, "get"> | null,
		rows: new Map<string, unknown>(),
		sessions: new Map<string, unknown>(),
		records: new RuntimeRecords(() => null),
		slotsRemoved: [] as string[],
		defaultMode: "terminal" as "chat" | "terminal",
		provided: new Map<string, FakeEndpoint | null>(),
		serializerFails: false,
	};
	state.index = { get: (tabId: string) => (state.rows.get(tabId) ?? null) as never };
	const calls: string[] = [];
	const lines: LoggedLine[] = [];
	const notes: { key: string; text: string }[] = [];
	const requests: { editorId: string; documentId: string }[] = [];
	const created: BridgeEditorEndpointOptions[] = [];
	const deps: BridgeHostDeps<FakeTab> = {
		tabs: () => state.tabs,
		tab: key => key === null ? undefined : state.tabs.get(key) ?? [...state.tabs.values()].find(candidate => candidate.tabId === key),
		tabState: key => {
			const existing = state.tabs.get(key);
			if (existing !== undefined) return existing;
			const created = newTab(key);
			state.tabs.set(key, created);
			return created;
		},
		index: () => state.index,
		sessions: () => ({ conversations: { liveOf: (tabId: string) => state.sessions.get(tabId) ?? null }, records: state.records }) as never,
		editors: () => state.editors,
		editorSlots: () => ({ remove: (slot: string) => { state.slotsRemoved.push(slot); } }) as never,
		endpoints: () => state.endpoints,
		liveEditors: () => state.live,
		diagnostics: () => ({ note: (key, text) => { notes.push({ key, text }); } }),
		passiveReasonForSlot: slot => state.passive.get(slot) ?? null,
		reserveSlot: (_index, conversation, slot, provenance) => state.editors.reserve({ tabId: conversation, editorId: slot, provenance, sequence: 1 }),
		defaultSessionMode: () => state.defaultMode,
		attachChatRoute: slot => { calls.push(`attachChatRoute:${slot}`); },
		refreshLauncher: () => { calls.push("refreshLauncher"); },
		cancelControlPicker: tabId => { calls.push(`cancelControlPicker:${tabId}`); },
		serializerFor: (_context, _index, viewType) => {
			calls.push(`serializerFor:${viewType}`);
			return { deserializeWebviewPanel: async () => {} };
		},
		handleRequest: (editorId, documentId) => { requests.push({ editorId, documentId }); },
		log: recordingLogger(lines),
		createEndpoint: options => {
			const editorId = options.scope.editorId;
			calls.push(`createEndpoint:${editorId}`);
			created.push(options);
			const provided = state.provided.get(editorId);
			if (provided !== undefined && provided !== null) return provided as never;
			const unbindable = new FakeEndpoint(editorId, options.scope.tabId);
			unbindable.port = null;
			unbindable.failure = "no listener";
			return unbindable as never;
		},
		...overrides,
	};
	const host: BridgeHost<FakeTab> = registerBridgeHost(deps);
	/** The index the reconciliation reads: the rows the case set, and no committed slot binding. */
	const index = { get: (tabId: string) => state.rows.get(tabId) ?? null, slotBinding: () => null } as unknown as SessionIndex;
	return { state, host, deps, calls, get logged(): string[] { return lines.map(line => line.message); }, lines, notes, requests, created, index };
}

let contexts = 0;
/** An extension context with storage of its own, which the host's real endpoint creation reads the record store from. */
const context0 = (): never => context(`stub-${contexts++}`);

beforeEach(() => {
	stub.window.tabGroups.all = [];
	stub.window.serializers.clear();
	stub.workspace.workspaceFolders = undefined;
});
afterEach(() => { stub.window.tabGroups.all = []; });

/** An editor the window holds: reserved, with a record carrying a fake endpoint and (optionally) a document. */
function editor(w: ReturnType<typeof world>, slot = EDITOR, options: { documentId?: string | null; panel?: boolean; endpoint?: FakeEndpoint; tabId?: string } = {}) {
	const tabId = options.tabId ?? TAB;
	const endpoint = options.endpoint ?? new FakeEndpoint(slot, tabId);
	const panel = options.panel === false ? null : fakePanel();
	const documentId = options.documentId === undefined ? DOCUMENT : options.documentId;
	w.state.editors.reserve({ tabId, editorId: slot, provenance: "saved", sequence: 1 });
	const tab = newTab(slot, { tabId, panel: panel as never, bridge: { editorId: slot, endpoint: endpoint as never, documentId, bound: false } });
	w.state.tabs.set(slot, tab);
	w.state.rows.set(tabId, { tabId });
	if (documentId !== null) endpoint.document = { documentId, bootstrapId: BOOTSTRAP, route: endpoint.route ?? fakeRoute() };
	return { tab, endpoint, panel };
}

describe("documentEligible", () => {
	it("is true for the exact document the host serves, while the panel handle or the real membership holds the editor", () => {
		const w = world();
		const { tab } = editor(w);
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), true);
		assert.equal(w.host.documentEligible(EDITOR, NEXT_DOCUMENT), false, "another document of the editor is not the one served");
		tab.panel = null;
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), false, "with no panel handle the editor must be in the real membership");
		w.state.live.add(EDITOR);
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), true, "a surviving page after a host-only restart");
	});

	it("is false for a non-controlling editor, an editor of another record, an unbound record and a row the index no longer has", () => {
		const w = world();
		editor(w);
		w.state.passive.set(EDITOR, "another editor controls it");
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), false);
		w.state.passive.clear();
		assert.equal(w.host.documentEligible(OTHER_EDITOR, DOCUMENT), false, "no record");
		w.state.tabs.get(EDITOR)!.bridge = { editorId: OTHER_EDITOR, endpoint: new FakeEndpoint() as never, documentId: DOCUMENT, bound: false };
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), false, "the record's bridge belongs to another editor");
		w.state.tabs.get(EDITOR)!.bridge = null;
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), false, "no bridge");
		w.state.tabs.get(EDITOR)!.bridge = { editorId: EDITOR, endpoint: new FakeEndpoint() as never, documentId: DOCUMENT, bound: false };
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), true);
		w.state.rows.clear();
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), false, "the row is gone");
	});

	it("answers from the index's absence when it has not been created yet", () => {
		const w = world();
		editor(w);
		w.state.index = null;
		assert.equal(w.host.documentEligible(EDITOR, DOCUMENT), true);
	});
});

describe("provisioning an editor's endpoint and document (real endpoint)", () => {
	it("binds the exact port once, for concurrent callers too, and mints a fresh document for each preparation", async () => {
		const w = world({ createEndpoint: realEndpoint });
		const ctx = await context("provision");
		const slot = EDITOR;
		w.state.editors.reserve({ tabId: TAB, editorId: slot, provenance: "saved", sequence: 1 });
		w.state.tabs.set(slot, newTab(slot, { tabId: TAB }));
		const [first, second] = await Promise.all([w.host.prepareDocument(ctx, slot), w.host.prepareDocument(ctx, slot)]);
		assert.ok(first !== null && second !== null);
		endpoints.push(first.endpoint);
		assert.equal(first.endpoint, second.endpoint, "endpoint creation is single-flight");
		assert.equal(w.state.endpoints.size, 1);
		assert.equal(w.state.endpoints.get(slot), first.endpoint);
		assert.ok(first.port > 0 && first.port === second.port, "one exact port per editor");
		assert.notEqual(first.documentId, second.documentId);
		assert.match(first.documentId, /^[0-9a-f]{32}$/);
		assert.match(first.bootstrapId, /^[0-9a-f]{32}$/);
		assert.ok(w.logged.some(line => line.startsWith(`tab ${TAB}: bridge listener bound on 127.0.0.1:${first.port} for editor ${slot.slice(0, 8)}`)));
		assert.equal(w.logged.filter(line => line.includes("bridge listener bound")).length, 1);
		const record = w.state.tabs.get(slot)!;
		assert.equal(record.bridge?.editorId, slot);
		assert.equal(record.bridge?.endpoint, first.endpoint);
		assert.ok(record.bridge?.documentId === first.documentId || record.bridge?.documentId === second.documentId, "the record names one of the documents prepared");
		assert.equal(record.bridge?.bound, false);
		assert.equal(w.host.ticketFacts(OTHER_EDITOR), null);
		assert.equal(w.host.endpointOf(slot), first.endpoint);
		assert.equal(w.host.endpointOf(OTHER_EDITOR), null);
		assert.equal(w.host.ticketFacts(slot)?.port, first.port);
		assert.equal(w.host.ticketFacts(slot)?.documentId, record.bridge?.documentId);
	});

	it("keeps the endpoint it created through a later preparation and hands the same listener back", async () => {
		const w = world({ createEndpoint: realEndpoint });
		const ctx = await context("again");
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: TAB }));
		const first = await w.host.prepareDocument(ctx, EDITOR);
		assert.ok(first);
		endpoints.push(first.endpoint);
		const adopted = await w.host.adoptEditor(ctx, EDITOR, fakePanel() as never);
		assert.equal(adopted, true);
		assert.equal(w.state.endpoints.get(EDITOR), first.endpoint, "adoption re-uses the listener");
		assert.ok(w.state.live.has(EDITOR));
	});

	it("provides no endpoint for an editor id this bridge did not mint", async () => {
		const w = world({ createEndpoint: realEndpoint });
		const ctx = await context("foreign");
		w.state.editors.reserve({ tabId: TAB, editorId: "not-minted-by-us", provenance: "saved", sequence: 1 });
		w.state.tabs.set("not-minted-by-us", newTab("not-minted-by-us", { tabId: TAB }));
		assert.equal(await w.host.prepareDocument(ctx, "not-minted-by-us"), null);
		assert.equal(w.state.endpoints.size, 0);
	});
});

describe("prepareDocument", () => {
	it("provisions nothing for an editor without a record, and nothing for a record without a reservation unless it is passive", async () => {
		const w = world();
		assert.equal(await w.host.prepareDocument(context0(), EDITOR), null);
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: TAB }));
		assert.equal(await w.host.prepareDocument(context0(), EDITOR), null, "no reservation");
		assert.deepEqual(w.calls, []);
		w.state.passive.set(EDITOR, "another editor controls it");
		const endpoint = new FakeEndpoint();
		w.state.provided.set(EDITOR, endpoint);
		w.state.tabs.get(EDITOR)!.bridge = { editorId: EDITOR, endpoint: endpoint as never, documentId: null, bound: false };
		assert.equal(await w.host.prepareDocument(context0(), EDITOR), null, "a passive slot may provision, but a document is kept only for the editor that holds the tab");
		assert.deepEqual(w.calls, [`createEndpoint:${EDITOR}`]);
		assert.ok(endpoint.calls.some(call => call.startsWith("retireDocument:")), "the document it minted for a slot that does not hold the tab is retired at once");
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		assert.ok(await w.host.prepareDocument(context0(), EDITOR), "a passive slot that holds the editor gets its document");
	});

	it("files the document under the namespace its endpoint was bound under, not the conversation it serves now", async () => {
		const endpoint = new FakeEndpoint(EDITOR, TAB);
		const w = world();
		w.state.provided.set(EDITOR, endpoint);
		w.state.editors.reserve({ tabId: OTHER_TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: OTHER_TAB, bridge: { editorId: EDITOR, endpoint: endpoint as never, documentId: null, bound: false } }));
		await w.host.prepareDocument(context0(), EDITOR);
		assert.deepEqual(w.created.map(options => options.scope.tabId), [TAB]);
		w.state.tabs.get(EDITOR)!.bridge = null;
		w.state.endpoints.clear();
		await w.host.prepareDocument(context0(), EDITOR);
		assert.deepEqual(w.created.map(options => options.scope.tabId), [TAB, OTHER_TAB], "an editor with no endpoint yet is filed under the conversation its reservation names");
	});

	it("points the record at the endpoint and the new document", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		w.state.provided.set(EDITOR, endpoint);
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		const tab = newTab(EDITOR, { tabId: TAB });
		w.state.tabs.set(EDITOR, tab);
		const prepared = await w.host.prepareDocument(context0(), EDITOR);
		assert.ok(prepared);
		assert.equal(prepared.endpoint, endpoint as never);
		assert.equal(prepared.port, 4747);
		assert.deepEqual(tab.bridge, { editorId: EDITOR, endpoint, documentId: prepared.documentId, bound: false });
		assert.equal(w.host.endpointOf(EDITOR), endpoint as never, "the endpoint the host created and bound is the window's own");
		assert.deepEqual(endpoint.calls, [`beginDocument:${prepared.documentId}`]);
	});

	it("rotates the document of the binding it already has and withdraws the acknowledgement of the old one", async () => {
		const w = world();
		const { tab, endpoint } = editor(w);
		tab.bridge!.bound = true;
		w.state.provided.set(EDITOR, endpoint);
		const bridge = tab.bridge;
		const prepared = await w.host.prepareDocument(context0(), EDITOR);
		assert.ok(prepared);
		assert.equal(tab.bridge, bridge, "the same binding object is updated in place");
		assert.equal(tab.bridge?.documentId, prepared.documentId);
		assert.equal(tab.bridge?.bound, false);
	});

	it("reports an endpoint whose listener could not bind, or a document the endpoint refused", async () => {
		const w = world();
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: TAB }));
		w.state.provided.set(EDITOR, null);
		assert.equal(await w.host.prepareDocument(context0(), EDITOR), null);
		assert.ok(w.lines.some(line => line.level === "warn" && line.message === `tab ${TAB}: the bridge listener could not bind (no listener)`));
		assert.equal(w.state.endpoints.size, 0, "an endpoint that did not bind is not kept");
		const endpoint = new FakeEndpoint();
		endpoint.beginDocumentFails = true;
		w.state.provided.set(EDITOR, endpoint);
		assert.equal(await w.host.prepareDocument(context0(), EDITOR), null);
		assert.ok(w.logged.includes(`slot ${EDITOR}: this editor's bridge document could not be prepared`));
	});

	it("retires a document it minted for an editor that lost its reservation or its record while it waited", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		w.state.provided.set(EDITOR, endpoint);
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		const tab = newTab(EDITOR, { tabId: TAB });
		w.state.tabs.set(EDITOR, tab);
		const pending = w.host.prepareDocument(context0(), EDITOR);
		w.state.editors.release(TAB, EDITOR);
		assert.equal(await pending, null);
		assert.ok(endpoint.calls.some(call => call.startsWith("retireDocument:")));
		assert.equal(tab.bridge, null);
	});
});

describe("adoptEditor", () => {
	it("refuses an editor this window does not hold", async () => {
		const w = world();
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: TAB }));
		assert.equal(await w.host.adoptEditor(context0(), EDITOR, null), false);
		assert.equal(w.state.live.has(EDITOR), false);
	});

	it("points the record at the endpoint, records the editor as present, and tells the endpoint only about a panel it was handed", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		w.state.provided.set(EDITOR, endpoint);
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		const tab = newTab(EDITOR, { tabId: TAB });
		w.state.tabs.set(EDITOR, tab);
		assert.equal(await w.host.adoptEditor(context0(), EDITOR, null), true);
		assert.deepEqual(tab.bridge, { editorId: EDITOR, endpoint, documentId: null, bound: false });
		assert.ok(w.state.live.has(EDITOR));
		assert.deepEqual(endpoint.calls, []);
		assert.equal(await w.host.adoptEditor(context0(), EDITOR, fakePanel() as never), true);
		assert.deepEqual(endpoint.calls, ["panelBound"]);
	});

	it("refuses when the endpoint cannot be provided, or the reservation was lost while it was provisioned", async () => {
		const w = world();
		w.state.editors.reserve({ tabId: TAB, editorId: EDITOR, provenance: "saved", sequence: 1 });
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: TAB }));
		w.state.provided.set(EDITOR, null);
		assert.equal(await w.host.adoptEditor(context0(), EDITOR, null), false);
		w.state.provided.set(EDITOR, new FakeEndpoint());
		const pending = w.host.adoptEditor(context0(), EDITOR, null);
		w.state.editors.release(TAB, EDITOR);
		assert.equal(await pending, false);
		assert.equal(w.state.live.has(EDITOR), false);
	});
});

describe("syncEditors", () => {
	/** VS Code's own membership: one group holding the given editors' tabs. */
	const membership = (...pairs: [string, string][]): void => {
		const group = { viewColumn: 1, tabs: [] as never[], activeTab: undefined };
		for (const [tabId, editorId] of pairs) group.tabs.push({ label: "chat", input: new stub.TabInputWebview(bridgeViewType(tabId, editorId)), group } as never);
		stub.window.tabGroups.all = [group] as never;
	};

	it("reads the editors from the tab inputs' view types and ignores a tab that is not one of ours", () => {
		const w = world();
		const group = { viewColumn: 1, tabs: [] as never[], activeTab: undefined };
		group.tabs.push({ label: "chat", input: new stub.TabInputWebview(`mainThreadWebview-${bridgeViewType(TAB, EDITOR)}`), group } as never);
		group.tabs.push({ label: "other", input: new stub.TabInputWebview("some.other.type"), group } as never);
		group.tabs.push({ label: "file", input: new stub.TabInputText(stub.Uri.file("/a.ts") as never), group } as never);
		stub.window.tabGroups.all = [group] as never;
		assert.deepEqual(w.host.editorMembership(), [{ tabId: TAB, editorId: EDITOR }]);
	});

	it("registers one serializer per recognized type, once, and marks its editors present", async () => {
		const w = world();
		membership([TAB, EDITOR], [OTHER_TAB, OTHER_EDITOR]);
		const ctx = context0();
		await w.host.syncEditors(ctx, w.index);
		await w.host.syncEditors(ctx, w.index);
		assert.deepEqual([...stub.window.serializers.keys()].sort(), [bridgeViewType(TAB, EDITOR), bridgeViewType(OTHER_TAB, OTHER_EDITOR)].sort());
		assert.equal(w.calls.filter(call => call.startsWith("serializerFor:")).length, 2);
		assert.equal((ctx as unknown as { subscriptions: unknown[] }).subscriptions.length, 2);
		assert.deepEqual([...w.state.live].sort(), [EDITOR, OTHER_EDITOR].sort());
	});

	it("forgets an editor VS Code no longer shows, and retires its bridge only when the tab set changed", async () => {
		const w = world();
		const { endpoint } = editor(w);
		w.state.live.add(EDITOR);
		membership();
		await w.host.syncEditors(context0(), w.index);
		assert.equal(w.state.live.has(EDITOR), false);
		assert.equal(w.state.editors.winner(TAB)?.editorId, EDITOR, "the activation pass has not necessarily listed every editor, so nothing is retired");
		w.state.live.add(EDITOR);
		await w.host.syncEditors(context0(), w.index, { retireMissing: true });
		await settle();
		assert.equal(w.state.editors.winner(TAB), null);
		assert.ok(endpoint.calls.includes("forget"));
		assert.equal(w.state.tabs.get(EDITOR)?.bridge, null);
	});

	it("elects the editor before it provisions, and skips a duplicate that lost the conversation", async () => {
		const w = world();
		w.state.rows.set(TAB, { tabId: TAB });
		w.state.editors.reserve({ tabId: TAB, editorId: OTHER_EDITOR, provenance: "saved", sequence: 1 });
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		assert.equal(w.calls.some(call => call.startsWith("createEndpoint")), false);
		assert.ok(w.state.live.has(EDITOR), "it is still observed");
	});

	it("skips an editor whose row the index no longer has", async () => {
		const w = world();
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		assert.equal(w.calls.some(call => call.startsWith("createEndpoint")), false);
	});

	it("leaves an editor that already has a document alone", async () => {
		const w = world();
		editor(w);
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		assert.equal(w.calls.some(call => call.startsWith("createEndpoint")), false);
	});

	it("gives an editor with a panel handle its endpoint, and provisions its document when it renders", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		w.state.provided.set(EDITOR, endpoint);
		w.state.rows.set(TAB, { tabId: TAB });
		w.state.tabs.set(EDITOR, newTab(EDITOR, { tabId: TAB, panel: fakePanel() as never }));
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		const tab = w.state.tabs.get(EDITOR)!;
		assert.deepEqual(tab.bridge, { editorId: EDITOR, endpoint, documentId: null, bound: false });
		assert.deepEqual(endpoint.calls, ["panelBound"]);
		assert.equal(w.state.editors.winner(TAB)?.editorId, EDITOR);
	});

	it("adopts the document a surviving page left, offers it and re-checks native readiness", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		endpoint.recorded = { documentId: DOCUMENT, bootstrapId: BOOTSTRAP, route: fakeRoute() };
		w.state.provided.set(EDITOR, endpoint);
		w.state.rows.set(TAB, { tabId: TAB });
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		const tab = w.state.tabs.get(EDITOR)!;
		assert.equal(tab.tabId, TAB);
		assert.equal(tab.mode, "terminal", "a record made here takes the default mode");
		assert.equal(tab.bridge?.documentId, DOCUMENT);
		assert.deepEqual(endpoint.calls.filter(call => call === "offerBridge" || call === "adoptRecordedDocument" || call.startsWith("nativeReady")), ["adoptRecordedDocument", "offerBridge", "nativeReady:false"]);
		assert.ok(w.logged.includes(`slot ${EDITOR}: adopted surviving bridge document ${DOCUMENT.slice(0, 8)}`));
		assert.ok(w.notes.some(note => note.key === EDITOR && note.text.startsWith("bridge: adopted surviving document")));
		assert.ok(w.calls.includes("refreshLauncher"));
	});

	it("moves the conversation's own record under the editor's key, with its runtime and counters", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		w.state.provided.set(EDITOR, endpoint);
		w.state.rows.set(TAB, { tabId: TAB });
		const held = newTab(TAB, { tabId: TAB });
		held.mode = "terminal";
		w.state.tabs.set(TAB, held);
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		assert.equal(w.state.tabs.has(TAB), false);
		assert.equal(w.state.tabs.get(EDITOR), held);
		assert.equal(held.slotId, EDITOR);
		assert.deepEqual(w.state.slotsRemoved, [TAB]);
	});

	it("forgets the endpoint of an editor that lost its reservation while it was provisioned", async () => {
		const endpoint = new FakeEndpoint();
		const w = world();
		w.state.provided.set(EDITOR, endpoint);
		endpoint.onBind = () => { w.state.editors.release(TAB, EDITOR); };
		w.state.rows.set(TAB, { tabId: TAB });
		membership([TAB, EDITOR]);
		await w.host.syncEditors(context0(), w.index);
		assert.ok(endpoint.calls.includes("forget"));
		assert.equal(w.state.endpoints.has(EDITOR), false);
	});
});

describe("pinning the origin a page reported", () => {
	const report = { documentId: DOCUMENT, bootstrapId: BOOTSTRAP, origin: ORIGIN };

	it("pins the origin of the exact document and panel the host serves, then commits it", () => {
		const w = world();
		const { endpoint, panel } = editor(w);
		w.host.pinOrigin(EDITOR, panel as never, report);
		assert.deepEqual(endpoint.calls, [`pinOrigin:${DOCUMENT}:${ORIGIN}`]);
		assert.ok(w.logged.includes(`tab ${EDITOR}: bridge origin pinned for document ${DOCUMENT.slice(0, 8)}`));
	});

	it("refuses a report from another panel, for another document, or for a bootstrap the host did not mint", () => {
		const w = world();
		const { endpoint, panel } = editor(w);
		w.host.pinOrigin(EDITOR, fakePanel() as never, report);
		w.host.pinOrigin(EDITOR, panel as never, { ...report, documentId: NEXT_DOCUMENT });
		w.host.pinOrigin(EDITOR, panel as never, { ...report, bootstrapId: "0".repeat(32) });
		assert.deepEqual(endpoint.calls, []);
		assert.ok(w.logged.includes(`tab ${EDITOR}: an origin report named a document this host no longer serves`));
		assert.ok(w.logged.includes(`tab ${EDITOR}: an origin report named a bootstrap this host did not mint`));
	});

	it("does not commit an origin the endpoint refused", () => {
		const w = world();
		const { endpoint, panel } = editor(w);
		endpoint.pinned = false;
		w.host.pinOrigin(EDITOR, panel as never, report);
		assert.deepEqual(endpoint.calls, [`pinOrigin:${DOCUMENT}:${ORIGIN}`]);
		assert.equal(w.logged.some(line => line.includes("bridge origin pinned")), false);
	});
});

describe("replayHeldReadyReport", () => {
	const held = { documentId: DOCUMENT, bootstrapId: BOOTSTRAP, origin: ORIGIN };

	it("applies the report a page made while its editor was passive, once the editor may act, and re-sends the secret", async () => {
		const w = world();
		const { tab, endpoint, panel } = editor(w);
		tab.heldReadyReport = held;
		w.state.passive.set(EDITOR, "electing");
		assert.equal(w.host.replayHeldReadyReport(tab), false, "the passive gate decides only when the report is honored");
		assert.deepEqual(tab.heldReadyReport, held);
		w.state.passive.clear();
		endpoint.redelivery = { documentId: DOCUMENT, bootstrapId: BOOTSTRAP, port: 4747, origin: ORIGIN, bindingHash: "h".repeat(64), secret: new Uint8Array([1, 2, 3]) };
		assert.equal(w.host.replayHeldReadyReport(tab), true);
		assert.equal(tab.heldReadyReport, null);
		await settle();
		assert.ok(endpoint.calls.includes(`pinOrigin:${DOCUMENT}:${ORIGIN}`));
		assert.ok(endpoint.calls.includes("delivery"));
		assert.equal(panel!.posted.at(-1)?.type, "omp:bridge-bind");
	});

	it("does nothing without a held report, a panel or a conversation", () => {
		const w = world();
		const { tab } = editor(w);
		assert.equal(w.host.replayHeldReadyReport(tab), false);
		tab.heldReadyReport = held;
		tab.panel = null;
		assert.equal(w.host.replayHeldReadyReport(tab), false);
		tab.panel = fakePanel() as never;
		tab.tabId = null;
		assert.equal(w.host.replayHeldReadyReport(tab), false);
	});
});

/** The runtime's record of the conversation an editor shows. */
const hold = (w: ReturnType<typeof world>, tab: FakeTab): ConversationRecord => w.state.records.acquire(tab.tabId as string, tab.slotId);

/** A verified chat host for the editor's conversation: the runtime, the index row and the live session agree. */
function verifiedChatHost(w: ReturnType<typeof world>, tab: FakeTab): BridgeNativeBinding {
	hold(w, tab).runtime = {
		kind: "chat", pid: 4242,
		identity: { childCreationTime: "ctime", slot: "slot-1", brokerId: "broker-1", brokerGeneration: "gen-1" },
	} as never;
	w.state.rows.set(TAB, {
		tabId: TAB, availability: "live", sessionId: "session-id", sessionFile: "/work/s.jsonl", host: { pid: 4242 },
		ownership: { ownerGeneration: "owner-1", releasedAt: null },
	});
	w.state.sessions.set(TAB, { phase: "live", headerId: "header-id" });
	return {
		ownerGeneration: "owner-1", pid: 4242, processCreation: "ctime", slot: "slot-1", brokerId: "broker-1", brokerGeneration: "gen-1",
		sessionId: "header-id", sessionFile: "/work/s.jsonl",
	} as never;
}

describe("liveBinding", () => {
	it("is the verified chat host's identity when the runtime, the row and the live session agree", () => {
		const w = world();
		const { tab } = editor(w);
		const expected = verifiedChatHost(w, tab);
		assert.deepEqual(w.host.liveBinding(EDITOR), expected);
	});

	it("is null while any fact is missing: no runtime, a released owner, another process, no exact file, a session that is not live", () => {
		const w = world();
		const { tab } = editor(w);
		assert.equal(w.host.liveBinding(EDITOR), null, "no runtime");
		verifiedChatHost(w, tab);
		w.state.sessions.set(TAB, { phase: "resyncing", headerId: null });
		assert.equal(w.host.liveBinding(EDITOR), null, "a conversation that is not live");
		w.state.sessions.set(TAB, { phase: "live", headerId: null });
		const row = w.state.rows.get(TAB) as Record<string, unknown>;
		assert.ok(w.host.liveBinding(EDITOR), "the row's session id stands in for a header-less session");
		row.ownership = { ownerGeneration: "owner-1", releasedAt: "now" };
		assert.equal(w.host.liveBinding(EDITOR), null, "a released claim");
		row.ownership = { ownerGeneration: "owner-1", releasedAt: null };
		row.host = { pid: 1 };
		assert.equal(w.host.liveBinding(EDITOR), null, "another process hosts it");
		row.host = { pid: 4242 };
		row.sessionFile = null;
		assert.equal(w.host.liveBinding(EDITOR), null, "no exact file yet");
		row.sessionFile = "/work/s.jsonl";
		row.availability = "stopped";
		assert.equal(w.host.liveBinding(EDITOR), null, "not live");
		w.state.index = null;
		assert.equal(w.host.liveBinding(EDITOR), null, "no index");
	});

	it("requires a terminal's control channel to report the same session file", () => {
		const w = world();
		const { tab } = editor(w);
		verifiedChatHost(w, tab);
		hold(w, tab).runtime = {
			kind: "terminal", pid: 4242,
			identity: { childCreationTime: "ctime", slot: "slot-1", brokerId: "broker-1", brokerGeneration: "gen-1" },
			observed: { available: true, sessionId: "session-id", sessionFile: "/work/s.jsonl" },
		} as never;
		assert.equal(w.host.liveBinding(EDITOR), null, "no open control channel");
		hold(w, tab).control = { client: { peerProof: true } as never, snapshot: null, activity: false };
		const binding = w.host.liveBinding(EDITOR);
		assert.equal(binding?.sessionId, "session-id");
		(hold(w, tab).runtime as unknown as { observed: { sessionFile: string } }).observed.sessionFile = "/work/other.jsonl";
		assert.equal(w.host.liveBinding(EDITOR), null, "another session file");
	});
});

describe("commitDocument and the secret delivery", () => {
	const delivery = () => ({ documentId: DOCUMENT, bootstrapId: BOOTSTRAP, port: 4747, origin: ORIGIN, bindingHash: "h".repeat(64), secret: new Uint8Array([1, 2, 3, 4]) });

	it("commits the document against the verified binding and sends the secret to the exact panel only", async () => {
		const w = world();
		const { tab, endpoint, panel } = editor(w);
		verifiedChatHost(w, tab);
		endpoint.commitDelivery = delivery();
		await w.host.commitDocument(EDITOR);
		assert.deepEqual(endpoint.calls, ["commit:header-id"]);
		assert.equal(panel!.posted.length, 1);
		const message = panel!.posted[0]!;
		assert.equal(message.type, "omp:bridge-bind");
		assert.equal(message.hostGeneration, encodeHex(w.host.hostGeneration));
		assert.equal(message.documentId, DOCUMENT);
		assert.equal(message.bootstrapId, BOOTSTRAP);
		assert.equal(message.workspace, "a".repeat(64));
		assert.equal(message.tabId, TAB);
		assert.equal(message.editorId, EDITOR);
		assert.equal(message.port, 4747);
		assert.equal(message.origin, ORIGIN);
		assert.equal(message.bindingHash, "h".repeat(64));
		assert.equal(typeof message.secret, "string");
		assert.equal(tab.bridge?.bound, false, "bound only when the page acknowledges");
		assert.ok(w.logged.includes(`tab ${EDITOR}: bridge document ${DOCUMENT.slice(0, 8)} committed`));
		assert.ok(w.notes.some(note => note.key === EDITOR && note.text.includes("committed for editor") && !note.text.includes("secret")));
	});

	it("commits nothing before the origin is pinned and the chat host verified, or once the page holds the secret", async () => {
		const w = world();
		const { tab, endpoint } = editor(w);
		await w.host.commitDocument(EDITOR);
		assert.deepEqual(endpoint.calls, [], "no verified chat host");
		verifiedChatHost(w, tab);
		tab.bridge!.bound = true;
		await w.host.commitDocument(EDITOR);
		assert.deepEqual(endpoint.calls, []);
		tab.bridge!.bound = false;
		tab.bridge!.documentId = null;
		await w.host.commitDocument(EDITOR);
		assert.deepEqual(endpoint.calls, []);
		await w.host.commitDocument("unknown");
	});

	it("does not deliver a secret to a panel whose document is not the committed one", async () => {
		const w = world();
		const { tab, endpoint, panel } = editor(w);
		verifiedChatHost(w, tab);
		endpoint.commitDelivery = { ...delivery(), documentId: NEXT_DOCUMENT };
		await w.host.commitDocument(EDITOR);
		assert.deepEqual(panel!.posted, []);
	});

	it("re-sends the committed secret without rotating it, unless the page already holds it", async () => {
		const w = world();
		const { tab, endpoint, panel } = editor(w);
		endpoint.redelivery = delivery();
		await w.host.redeliverBinding(EDITOR);
		assert.deepEqual(endpoint.calls, ["delivery"]);
		assert.equal(panel!.posted.length, 1);
		tab.bridge!.bound = true;
		await w.host.redeliverBinding(EDITOR);
		assert.equal(panel!.posted.length, 1);
		assert.deepEqual(endpoint.calls, ["delivery"]);
	});
});

describe("routes", () => {
	it("offers the document's route over the panel when the host holds the handle, and over the bridge when it does not", () => {
		const w = world();
		const { endpoint, panel, tab } = editor(w);
		w.host.offerRoute(EDITOR);
		assert.deepEqual(w.calls, [`cancelControlPicker:${EDITOR}`]);
		assert.deepEqual(endpoint.calls, ["offerPanel"]);
		assert.deepEqual(panel!.posted, [{
			type: "omp:route-offer", hostGeneration: encodeHex(w.host.hostGeneration), documentId: DOCUMENT, routeGeneration: "r".repeat(32), status: "ready",
		}]);
		tab.panel = null;
		w.host.offerRoute(EDITOR);
		assert.deepEqual(endpoint.calls, ["offerPanel", "offerBridge"]);
	});

	it("offers nothing for an editor with no ticket yet, and no panel offer when the endpoint minted no generation", () => {
		const w = world();
		const { endpoint, panel, tab } = editor(w, EDITOR, { documentId: null });
		w.host.offerRoute(EDITOR);
		assert.deepEqual(endpoint.calls, []);
		tab.bridge!.documentId = DOCUMENT;
		endpoint.document = { documentId: DOCUMENT, bootstrapId: BOOTSTRAP, route: endpoint.route! };
		endpoint.route!.routeGeneration = null;
		w.host.offerRoute(EDITOR);
		assert.deepEqual(panel!.posted, []);
	});

	it("resolves the route of the current document only", () => {
		const w = world();
		const { endpoint, tab } = editor(w);
		assert.equal(w.host.routeOf(EDITOR), endpoint.document!.route as never);
		tab.bridge!.documentId = null;
		assert.equal(w.host.routeOf(EDITOR), null);
		assert.equal(w.host.routeOf("unknown"), null);
	});

	it("acknowledges the route generation the page was offered, and re-offers only the first acknowledgement", () => {
		const w = world();
		const { endpoint, panel } = editor(w);
		const message = { type: "omp:route-ack", hostGeneration: encodeHex(w.host.hostGeneration), documentId: DOCUMENT, routeGeneration: "r".repeat(32) };
		w.host.acknowledgeRoute(EDITOR, panel as never, message as never);
		assert.deepEqual(endpoint.route!.acknowledgedKinds, ["panel"]);
		assert.equal(panel!.posted.length, 1, "the acknowledged route's status is offered once");
		assert.ok(w.notes.some(note => note.key === EDITOR && note.text.includes("acknowledged over panel")));
		w.host.acknowledgeRoute(EDITOR, panel as never, message as never);
		assert.equal(panel!.posted.length, 1, "a repeated acknowledgement does not start another round trip");
	});

	it("refuses an acknowledgement from another panel, host generation or document, and one for a fenced generation", () => {
		const w = world();
		const { endpoint, panel } = editor(w);
		const good = { type: "omp:route-ack", hostGeneration: encodeHex(w.host.hostGeneration), documentId: DOCUMENT, routeGeneration: "r".repeat(32) };
		w.host.acknowledgeRoute(EDITOR, fakePanel() as never, good as never);
		w.host.acknowledgeRoute(EDITOR, panel as never, { ...good, hostGeneration: "0".repeat(32) } as never);
		w.host.acknowledgeRoute(EDITOR, panel as never, { ...good, documentId: NEXT_DOCUMENT } as never);
		w.host.acknowledgeRoute(EDITOR, panel as never, { ...good, routeGeneration: "z".repeat(32) } as never);
		assert.deepEqual(endpoint.route!.acknowledgedKinds, []);
		assert.ok(w.logged.includes(`tab ${EDITOR}: a route acknowledgement named another host generation or document`));
		assert.ok(w.logged.includes(`tab ${EDITOR}: a route acknowledgement named a fenced generation`));
		assert.equal(panel!.posted.length, 0);
	});

	it("marks the secret delivered only when the page names the binding the host committed", () => {
		const w = world();
		const { tab, endpoint, panel } = editor(w);
		endpoint.committedHash = "h".repeat(64);
		const message = { type: "omp:bridge-ack", hostGeneration: encodeHex(w.host.hostGeneration), documentId: DOCUMENT, bindingHash: "x".repeat(64) };
		w.host.acknowledgeSecret(EDITOR, panel as never, message as never);
		assert.equal(tab.bridge?.bound, false);
		assert.ok(w.logged.includes(`tab ${EDITOR}: a bridge acknowledgement named a binding this host did not commit`));
		w.host.acknowledgeSecret(EDITOR, fakePanel() as never, { ...message, bindingHash: "h".repeat(64) } as never);
		assert.equal(tab.bridge?.bound, false, "another panel's acknowledgement is not the page's");
		w.host.acknowledgeSecret(EDITOR, panel as never, { ...message, bindingHash: "h".repeat(64) } as never);
		assert.equal(tab.bridge?.bound, true);
		assert.ok(w.logged.includes(`tab ${EDITOR}: the panel acknowledged its bridge secret`));
		assert.ok(endpoint.calls.includes("nativeReady:false"), "readiness is re-checked after the acknowledgement");
	});
});

describe("refreshReadiness", () => {
	it("tells the endpoint the native side is ready only while the committed binding is the one verified now", () => {
		const w = world();
		const { tab, endpoint } = editor(w);
		const expected = verifiedChatHost(w, tab);
		endpoint.committed = expected;
		w.host.refreshReadiness(EDITOR);
		assert.ok(endpoint.calls.includes("nativeReady:true"));
		endpoint.committed = { ...expected, pid: 1 };
		w.host.refreshReadiness(EDITOR);
		assert.equal(endpoint.calls.filter(call => call === "nativeReady:false").length, 1);
		endpoint.committed = null;
		w.host.refreshReadiness(EDITOR);
		assert.equal(endpoint.calls.filter(call => call === "nativeReady:false").length, 2);
	});

	it("does nothing for an editor with no document", () => {
		const w = world();
		const { endpoint } = editor(w, EDITOR, { documentId: null });
		w.host.refreshReadiness(EDITOR);
		assert.deepEqual(endpoint.calls, []);
	});
});

describe("retireClosedEditor", () => {
	it("releases the editor's reservation, drops its endpoint and records and keeps every other editor's", async () => {
		const w = world();
		const { endpoint, tab } = editor(w);
		const other = editor(w, OTHER_EDITOR, { tabId: OTHER_TAB });
		w.state.live.add(EDITOR);
		w.state.live.add(OTHER_EDITOR);
		w.state.endpoints.set(EDITOR, endpoint as never);
		w.state.endpoints.set(OTHER_EDITOR, other.endpoint as never);
		w.host.retireClosedEditor(EDITOR);
		assert.equal(w.state.editors.winner(TAB), null, "the reservation is released synchronously");
		assert.equal(tab.bridge, null);
		assert.equal(w.state.live.has(EDITOR), false);
		assert.equal(w.state.endpoints.has(EDITOR), false);
		await settle();
		assert.ok(endpoint.calls.includes("forget"));
		assert.ok(w.logged.includes(`slot ${EDITOR}: the closed editor's bridge was retired`));
		assert.ok(w.notes.some(note => note.key === EDITOR && note.text.includes("closed; endpoint and records retired")));
		assert.equal(w.state.editors.winner(OTHER_TAB)?.editorId, OTHER_EDITOR);
		assert.ok(w.state.live.has(OTHER_EDITOR));
		assert.equal(other.endpoint.calls.length, 0);
	});

	it("forgets the endpoint of an editor that holds no reservation, and one still being created", async () => {
		const w = world();
		const endpoint = new FakeEndpoint();
		w.state.endpoints.set(EDITOR, endpoint as never);
		w.host.retireClosedEditor(EDITOR);
		await settle();
		assert.ok(endpoint.calls.includes("forget"));
		assert.equal(w.state.endpoints.has(EDITOR), false);
	});
});

describe("registerSerializer", () => {
	it("registers the serializer the editor panels build for one view type, once, on the context's subscriptions", () => {
		const w = world();
		const ctx = context0();
		const viewType = bridgeViewType(TAB, EDITOR);
		w.host.registerSerializer(ctx, w.index, viewType);
		w.host.registerSerializer(ctx, w.index, viewType);
		assert.deepEqual([...stub.window.serializers.keys()], [viewType]);
		assert.deepEqual(w.calls, [`serializerFor:${viewType}`]);
		assert.equal((ctx as unknown as { subscriptions: unknown[] }).subscriptions.length, 1);
	});
});
