/**
 * The compound flows of one session's editor, over counted fakes of the window: the order in which an open waits, joins and
 * asks, which view change enters the pending display, and what the restart and resume flows refuse or report. The real
 * admission, fences and editors are the runtime's and the panels' own (their tests); the lifecycle test drives the flows through
 * the real extension.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import type * as vscode from "vscode";
import type { RestoreOutcome, SessionIndex } from "../host/session-index.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import { registerSessionFlows } from "./session-flows.ts";
import type { SessionFlowsDeps, SessionFlowsTab } from "./session-flows.ts";

const TAB = "tab:11111111-1111-4111-8111-111111111111";
const SLOT = "22222222222222222222222222222222";
const CONTEXT = { globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext;

/** One editor record, as the window holds it. */
function record(slotId: string, tabId: string | null = null): SessionFlowsTab {
	return {
		slotId, tabId, panel: null, mode: "chat", heldReadyReport: null, bridge: null, document: null, origin: null,
		lastOpenRequest: -1, lastEditorClose: -1, editorOfAttempt: false, openingVerb: null, openDeclined: false,
	};
}

/** The row of a stopped session: no recorded host and no saved file, so an open asks nothing of the user. */
function stoppedRow(): SessionIndexEntry {
	return { tabId: TAB, cwd: "/work", title: "Fixture", sessionFile: null, sessionId: null, host: null, runIntent: "stopped" } as unknown as SessionIndexEntry;
}

const RESTORED: RestoreOutcome = { status: "restored", tabId: TAB, sessionFile: null, detail: "" } as unknown as RestoreOutcome;

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await setImmediate();
}

/** A window of fakes: each dependency records the call that matters to a decision, the rest answer the neutral default. */
function world(overrides: Partial<SessionFlowsDeps<SessionFlowsTab>> = {}) {
	const lines: LoggedLine[] = [];
	const tabs = new Map<string, SessionFlowsTab>();
	const rows = new Map<string, SessionIndexEntry>();
	const calls: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const steps: [string, string][] = [];
	const entries: [string, string, unknown][] = [];
	const opens: { allowStoppedResume: boolean; mode: string }[] = [];
	const notices: [string, string][] = [];
	const unavailable: [string, string][] = [];
	const ended: string[] = [];
	const state = {
		sequence: 0,
		catalogReady: Promise.resolve() as Promise<void>,
		held: false,
		routed: false,
		/** Resolves the admission of a launch; `null` answers at once. */
		admission: null as Promise<void> | null,
		outcome: RESTORED,
	};
	const openingTabs = new Map<string, Promise<void>>();
	const stateOf = (key: string | null): SessionFlowsTab | undefined => key === null ? undefined : tabs.get(key);
	const index = {
		get: (tabId: string) => { calls.push(`index.get ${tabId}`); return rows.get(tabId) ?? null; },
		slotBinding: () => null,
		lifecycle: { run: (_tabId: string, work: () => Promise<unknown>) => work() },
		setEditorMode: async () => undefined,
	} as unknown as SessionIndex;
	const conversations = {
		stateOf: () => null,
		kindOf: () => null,
		liveOf: () => null,
		notify: (tabId: string, text: string) => { notices.push([tabId, text]); return false; },
		has: () => false,
		showViewOnly: async () => undefined,
	};
	const deps: SessionFlowsDeps<SessionFlowsTab> = {
		tab: stateOf,
		tabState: key => {
			let found = tabs.get(key);
			if (found === undefined) { found = record(key, key.startsWith("tab:") ? key : null); tabs.set(key, found); }
			return found;
		},
		openingTabs: () => openingTabs,
		liveEditors: () => new Set<string>(),
		nextEditorEvent: () => ++state.sequence,
		pendingSessionViewChanges: () => new Map(),
		draftRestores: () => new Map(),
		outcomes: () => new Map(),
		ensureCatalogReady: () => state.catalogReady,
		startupRestore: () => null,
		routing: () => ({
			consumeRequestedSelection: tabId => { calls.push(`routing.consume ${tabId}`); return false; },
			heldByAnotherWindow: async () => { calls.push("routing.held"); return state.held; },
			switchToWindow: async (_index, tabId) => { calls.push(`routing.switch ${tabId}`); },
			routeOpen: async (_index, tabId, _verb, mode) => { calls.push(`routing.route ${tabId} ${mode}`); return state.routed; },
		}),
		passiveReasonForSlot: () => null,
		defaultSessionMode: () => "chat",
		pending: () => ({
			begin: (key, kind) => { calls.push(`pending.begin ${key} ${kind}`); return { step: () => undefined, end: () => undefined }; },
			step: (key, step) => { steps.push([key, step]); },
		}),
		launchTimeline: () => ({ begin: () => undefined, lap: () => undefined, abandon: () => undefined }),
		pendingEntry: (key, kind, options, run) => {
			entries.push([key, kind, options]);
			return run({ step: () => undefined, end: status => { ended.push(status); } });
		},
		timedLaunch: async (tabId, kind) => { calls.push(`timedLaunch ${tabId} ${kind}`); return undefined as never; },
		sessionRuntime: () => ({
			conversations,
			open: async (request: { readonly allowStoppedResume?: boolean; readonly mode?: string }) => {
				calls.push("runtime.open");
				opens.push({ allowStoppedResume: request.allowStoppedResume ?? false, mode: request.mode ?? "" });
				await state.admission;
				return state.outcome;
			},
			verifiedWriterPid: async () => null,
			snapshot: () => undefined,
			replaceWriter: async () => { calls.push("runtime.replaceWriter"); throw new Error("a flow that refused must not replace a writer"); },
			endTransition: () => undefined,
		}) as never,
		hostOf: () => null,
		recordOf: () => undefined,
		recordFor: () => { throw new Error("no record is read"); },
		controlOf: () => null,
		fencedOf: () => false,
		liveAt: () => null,
		beginTransition: () => { calls.push("beginTransition"); throw new Error("no fence is raised"); },
		withSessionReadDeadline: read => read,
		ensureTerminalPipeline: () => undefined,
		refreshLauncher: () => { calls.push("refreshLauncher"); },
		launcherFacts: () => ({ running: false }),
		launcherOwnershipFacts: async () => { calls.push("launcherOwnershipFacts"); return {}; },
		confirmOpenAnyway: async () => true,
		launcherProvider: () => undefined,
		sessionTarget: (_index, argument) => argument === null ? null : { tabId: String(argument), entry: rows.get(String(argument)) as SessionIndexEntry },
		revealActiveSession: async () => undefined,
		editorPanels: () => ({
			openPanel: (_context, _index, tabId) => { calls.push(`openPanel ${tabId}`); const open = tabs.get(tabId); if (open !== undefined) open.panel = { dispose: () => { calls.push(`dispose ${tabId}`); } } as never; },
			renderPanelDocument: () => undefined,
		}),
		bridgeHost: () => ({ prepareDocument: async () => null }),
		guestDispatcher: () => ({
			presentUnavailable: (_index, tabId, reason) => { unavailable.push([tabId, reason]); },
			carryDraftFrom: async () => null,
			captureDraft: async () => null,
			releaseCarriedDraft: () => undefined,
		}),
		sessionActions: () => ({ stopVerifiedOwnedWriter: async () => false, stopHost: async () => false }),
		revealExistingTab: async (_index, tabId) => { calls.push(`reveal ${tabId}`); },
		reviveEditorPanel: async () => ({ selected: false, panel: null }),
		electLocalController: async () => undefined,
		attachChatRoutes: () => undefined,
		pushSessionView: () => undefined,
		activateNativeEditor: () => undefined,
		refreshGuestContext: () => undefined,
		handleRestoreOutcome: async (_context, _index, tabId, outcome) => { calls.push(`outcome ${tabId} ${outcome.status}`); },
		showWarningMessage: async () => undefined,
		showWarningActions: async () => undefined,
		log: recordingLogger(lines),
		warn: message => { warnings.push(message); },
		error: message => { errors.push(message); },
		...overrides,
	};
	const flows = registerSessionFlows(deps);
	return { flows, index, tabs, rows, calls, warnings, errors, steps, entries, opens, notices, unavailable, ended, lines, state, openingTabs };
}

describe("opening a tab", () => {
	it("waits for the catalog to be read before it resolves the row", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		const catalog = Promise.withResolvers<void>();
		w.state.catalogReady = catalog.promise;
		const opening = w.flows.openTab(CONTEXT, w.index, TAB, "started");
		await settle();
		assert.deepEqual(w.calls, [`routing.consume ${TAB}`], "an explicit open supersedes the request's deferral first, then reads nothing");
		assert.deepEqual(w.steps, [[TAB, "waiting"]]);
		catalog.resolve();
		await opening;
		assert.ok(w.calls.includes(`index.get ${TAB}`));
		assert.deepEqual(w.calls.filter(call => call.startsWith("runtime.") || call.startsWith("openPanel")), [`openPanel ${TAB}`, "runtime.open"], "the editor exists before the admission");
	});

	it("consumes a request's deferral only for the user's own open, never for a restoring one", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		await w.flows.openTab(CONTEXT, w.index, TAB, "opened", "restored");
		assert.deepEqual(w.calls.filter(call => call.startsWith("routing.")), []);
		await w.flows.openTab(CONTEXT, w.index, TAB, "started", "explicit");
		assert.deepEqual(w.calls.filter(call => call.startsWith("routing.")), [`routing.consume ${TAB}`]);
	});

	it("tells the user a row that is gone and starts nothing", async () => {
		const w = world();
		await w.flows.openTab(CONTEXT, w.index, TAB, "started");
		assert.deepEqual(w.errors, ["This session is no longer in Sessions. Refresh and try again."]);
		assert.deepEqual(w.opens, []);
	});

	it("lets two clicks on one tab share one attempt, and reveals the editor the first click created", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		const admission = Promise.withResolvers<void>();
		w.state.admission = admission.promise;
		const first = w.flows.openTab(CONTEXT, w.index, TAB, "started");
		await settle();
		assert.equal(w.openingTabs.has(TAB), true, "the attempt in flight is the tab's one entry");
		const second = w.flows.openTab(CONTEXT, w.index, TAB, "started");
		await settle();
		assert.equal(w.opens.length, 1, "the second click reaches no second admission");
		admission.resolve();
		await Promise.all([first, second]);
		assert.equal(w.opens.length, 1);
		assert.equal(w.openingTabs.size, 0, "the entry is removed when the attempt settles, so a later click is a fresh attempt");
		assert.deepEqual(w.calls.filter(call => call.startsWith("openPanel") || call.startsWith("reveal")), [`openPanel ${TAB}`, `reveal ${TAB}`]);
		assert.equal(w.tabs.get(TAB)?.openingVerb, null);
	});

	it("takes a resume that joined a history view for a launch request, and runs it once the history view is over", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		const admission = Promise.withResolvers<void>();
		w.state.admission = admission.promise;
		const history = w.flows.openTab(CONTEXT, w.index, TAB, "opened");
		await settle();
		const launch = w.flows.openTab(CONTEXT, w.index, TAB, "resumed");
		await settle();
		assert.equal(w.opens.length, 1, "nothing is launched while the history view is still being opened");
		w.state.admission = null;
		admission.resolve();
		await Promise.all([history, launch]);
		assert.deepEqual(w.opens.map(open => open.allowStoppedResume), [false, true], "opening history never lifts a stopped intent; the resume does");
	});

	it("shows the editor before it asks anything about an outside writer", async () => {
		const w = world({ launcherOwnershipFacts: async () => ({ externalOmp: true }), confirmOpenAnyway: async () => false });
		w.rows.set(TAB, { ...stoppedRow(), runIntent: "running" } as unknown as SessionIndexEntry);
		await w.flows.openTab(CONTEXT, w.index, TAB, "resumed");
		assert.deepEqual(w.steps.map(([, step]) => step), ["waiting", "ownership", "confirm"]);
		assert.equal(w.calls.includes(`openPanel ${TAB}`), true);
		assert.deepEqual(w.opens, [], "Cancel starts nothing");
		assert.equal(w.tabs.get(TAB)?.openDeclined, true);
		assert.equal(w.calls.includes(`dispose ${TAB}`), true, "the editor the attempt created is closed again");
	});
});

describe("changing an editor's view", () => {
	function viewTab(w: ReturnType<typeof world>, panel: boolean): SessionFlowsTab {
		const tab = record(SLOT, TAB);
		tab.panel = panel ? {} as never : null;
		w.tabs.set(SLOT, tab);
		return tab;
	}

	it("does not enter the pending display for an editor that has no panel, and says it cannot change views", async () => {
		const w = world();
		const tab = viewTab(w, false);
		await w.flows.switchSessionMode(CONTEXT, w.index, tab, "terminal");
		assert.deepEqual(w.entries, []);
		assert.deepEqual(w.warnings, ["This editor cannot change views while the session is starting or stopping, or another editor controls it."]);
		assert.equal(w.state.sequence, 0, "a refused request takes no place in the editor event order");
	});

	it("is a resume for an editor that runs nothing and a view-switch for one that runs a process", async () => {
		const stopped = world({ pendingEntry: async (key, kind, options) => { stopped.entries.push([key, kind, options]); return undefined as never; } });
		await stopped.flows.switchSessionMode(CONTEXT, stopped.index, viewTab(stopped, true), "terminal");
		assert.deepEqual(stopped.entries, [[TAB, "resume", { origin: "composer", step: "checking" }]]);
		const running = world({
			hostOf: () => ({ kind: "chat" }) as never,
			pendingEntry: async (key, kind, options) => { running.entries.push([key, kind, options]); return undefined as never; },
		});
		await running.flows.switchSessionMode(CONTEXT, running.index, viewTab(running, true), "terminal");
		assert.deepEqual(running.entries, [[TAB, "view-switch", { origin: "composer", step: "checking" }]]);
	});

	it("refuses to change the view of an editor whose tab is still opening", async () => {
		const w = world();
		const tab = viewTab(w, true);
		w.openingTabs.set(TAB, new Promise<void>(() => undefined));
		await w.flows.switchSessionMode(CONTEXT, w.index, tab, "terminal");
		assert.equal(w.warnings.length, 1);
		assert.equal(tab.lastOpenRequest, -1);
		assert.deepEqual(w.calls.filter(call => call.startsWith("runtime.")), []);
	});
});

describe("opening a session in an explicit view", () => {
	it("asks for a session when the command names none", async () => {
		const w = world();
		await w.flows.openSessionInMode(CONTEXT, w.index, null, "chat", "show");
		assert.deepEqual(w.warnings, ["Select an OMP session to show."]);
	});

	it("switches to the window that holds the session before anything is asked or launched", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		w.state.held = true;
		await w.flows.openSessionInMode(CONTEXT, w.index, TAB, "terminal");
		assert.deepEqual(w.calls, ["routing.held", `routing.switch ${TAB}`]);
	});

	it("opens the session in the window its folder is open in, and starts nothing here", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		w.state.routed = true;
		await w.flows.openSessionInMode(CONTEXT, w.index, TAB, "terminal");
		assert.deepEqual(w.calls, ["routing.held", `routing.route ${TAB} terminal`]);
	});

	it("keeps a launch another window asked for in this window, as an explicit launch", async () => {
		const w = world();
		w.rows.set(TAB, stoppedRow());
		await w.flows.openSessionInMode(CONTEXT, w.index, TAB, "chat", "open", true, true);
		assert.deepEqual(w.calls, [`timedLaunch ${TAB} open`], "no routing is consulted");
	});
});

describe("restarting an unresponsive Chat", () => {
	it("refuses, by the page and by a notice, when this window holds no controlling Chat editor for it, and stops nothing", async () => {
		const w = world();
		await w.flows.restartChat(CONTEXT, w.index, TAB, "nonce", "request");
		const text = "Restart requires this controlling Chat editor, an OMP process that does not answer or no longer serves this conversation, and its exact saved conversation. Nothing was stopped.";
		assert.deepEqual(w.notices, [[TAB, text]]);
		assert.deepEqual(w.warnings, [text]);
		assert.deepEqual(w.calls.filter(call => !call.startsWith("index.get")), []);
	});
});

describe("resuming a stopped Chat", () => {
	it("reports a launch that threw on the page, and ends the pending operation as failed", async () => {
		const w = world({
			ensureCatalogReady: () => Promise.reject(new Error("the catalog is unreadable")),
			timedLaunch: (_tabId, _kind, _commandAt, run) => run(),
		});
		await w.flows.resumeFromChat(CONTEXT, w.index, TAB, "request");
		assert.deepEqual(w.entries, [[TAB, "resume", { origin: "composer", requestId: "request" }]]);
		assert.deepEqual(w.ended, ["failed"]);
		assert.deepEqual(w.unavailable, [[TAB, "The session could not be resumed: the catalog is unreadable"]]);
		assert.ok(w.lines.some(line => /Resume from Chat failed: the catalog is unreadable/.test(line.message)));
	});
});
