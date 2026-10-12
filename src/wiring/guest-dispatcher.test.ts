/**
 * The guest dispatcher through its interface with fake dependencies: which owner each `omp:*` page message
 * reaches, what the bounded handoffs (composer draft, page selection) ask of a page and what a silent or foreign
 * answer leaves behind, how a chat command's outcome is reported to the page, and how a tab without a live
 * conversation is presented.
 *
 * Everything of the window (tab records, conversation runtime, editor and bridge lifecycle, terminal, control
 * exchanges, notices) is a fake that records what it was asked; `vscode` is the stand-in of
 * `vscode-test-stub.ts`, so this file must run under `node --test`. The timeouts of the handoffs run on mocked
 * timers.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { ChatPage } from "../host/chat-runtime.ts";
import type { SessionIndex } from "../host/session-index.ts";
import type { CarriedDraft, GuestDispatcher, GuestDispatcherDeps, GuestTab } from "./guest-dispatcher.ts";

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
const { registerGuestDispatcher } = await import("./guest-dispatcher.ts");
const { GUEST_PROTOCOL_VERSION } = await import("../protocol/messages.ts");
const { DETAIL_VIEW_TYPE } = await import("../host/detail-tabs.ts");
const { TAB_INPUT_VIEW_TYPE_PREFIX } = await import("../host/bridge-identity.ts");

const SLOT = "slot-1";
const OTHER_SLOT = "slot-2";
const TAB = "tab:11111111-2222-4333-8444-555555555555";
const HEX = (digit: string): string => digit.repeat(32);
const REQUEST = HEX("a");
const SCOPE = "11111111-2222-4333-8444-555555555555";

/** An editor record the cases may change after the dispatcher has seen it (a document replaced, a panel disposed). */
type FakeTab = { -readonly [K in keyof GuestTab]: GuestTab[K] };

interface PostedMessage {
	type: string;
	requestId?: number;
	[key: string]: unknown;
}
type OnPost = (message: PostedMessage) => Promise<void> | void;

/** One editor of a fake window: its record, its panel and what the panel was sent. */
interface FakeEditor {
	tab: FakeTab;
	panel: never;
	posted: PostedMessage[];
	/** Whether the panel accepts what it is sent (a disposed panel does not). */
	state: { accept: boolean };
}

/** A panel whose `postMessage` records and may answer, like a page that is listening. */
function fakePanel(onPost?: OnPost): Pick<FakeEditor, "panel" | "posted" | "state"> {
	const posted: PostedMessage[] = [];
	const state = { accept: true };
	const panel = {
		webview: {
			postMessage: async (message: PostedMessage) => {
				posted.push(message);
				await onPost?.(message);
				return state.accept;
			},
		},
	};
	return { panel: panel as never, posted, state };
}

const guestDocument = (): { kind: string } => ({ kind: "guest" });

function tabRecord(slotId: string, panel: unknown, overrides: Partial<FakeTab> = {}): FakeTab {
	return { slotId, tabId: TAB, mode: "chat", panel: panel as never, document: guestDocument(), heldReadyReport: null, runtime: null, bridge: null, ...overrides };
}

const indexOf = (entries: Record<string, { cwd: string; sessionFile: string | null; title: string | null }>): SessionIndex =>
	({ get: (tabId: string) => entries[tabId] ?? null }) as never;

/** What one fake window did when the dispatcher called into it, and the records the cases set. */
function world(overrides: Partial<GuestDispatcherDeps<FakeTab>> = {}) {
	const state = {
		tabs: new Map<string, FakeTab>(),
		draftRestores: new Map<string, CarriedDraft<FakeTab>>(),
		popups: new Set<string>(),
		context: { id: "context" } as never,
		active: null as (FakeTab & { tabId: string; panel: never }) | null,
		kind: null as "live" | "view-only" | "legacy" | null,
		epoch: { nonce: "n", counter: 4 } as unknown,
		outcome: "accepted" as string,
		handleMessageThrows: false,
		files: ["a.ts", "b/c.ts"],
		route: null as { routeGeneration: string | null } | null,
	};
	const calls: string[] = [];
	const logged: string[] = [];
	const infos: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const chatMessages: { tabId: string; message: { type: string }; page: ChatPage }[] = [];
	const remembered: string[] = [];
	const viewOnly: { tabId: string; input: Record<string, unknown> }[] = [];
	const routesAttached: unknown[][] = [];
	const detailOpens: { conversation: string; target: unknown }[] = [];
	const chatActions: unknown[][] = [];
	const terminalMessages: { slot: string; type: string }[] = [];
	const terminalCopies: { tab: FakeTab; reply: Parameters<GuestDispatcherDeps<FakeTab>["acceptTerminalCopy"]>[1] }[] = [];
	const modeSwitches: unknown[][] = [];
	const controlRequests: unknown[][] = [];
	const pinned: unknown[][] = [];
	const acknowledged: { kind: string; tabId: string; panel: unknown }[] = [];
	const deps: GuestDispatcherDeps<FakeTab> = {
		context: () => state.context,
		tabs: () => state.tabs,
		tab: key => key === null ? undefined : state.tabs.get(key) ?? [...state.tabs.values()].find(candidate => candidate.tabId === key),
		activePanelTab: () => state.active,
		draftRestores: () => state.draftRestores,
		composerPopupTabs: () => state.popups,
		chat: () => ({
			handleMessage: async (tabId: string, message: { type: string }, page: ChatPage) => {
				chatMessages.push({ tabId, message, page });
				if (state.handleMessageThrows) throw new Error("channel failed");
				return state.outcome;
			},
			stateOf: () => ({ epoch: state.epoch }),
			kindOf: () => state.kind,
			showViewOnly: async (tabId: string, input: Record<string, unknown>) => { viewOnly.push({ tabId, input }); state.kind = "view-only"; },
		}) as never,
		detailTabs: () => ({ open: (conversation, target) => { detailOpens.push({ conversation, target }); return "created"; } }),
		panelChatPage: (tab, panel) => ({ id: `page-of-${tab.slotId}`, post: () => "sent", panel }) as never,
		attachChatRoute: (slot, force) => { calls.push(`attachChatRoute:${slot}:${force}`); },
		attachChatRoutes: (tabId, force) => { routesAttached.push([tabId, force]); },
		rememberPrompt: text => { remembered.push(text); },
		runChatAction: async (...args) => { chatActions.push(args); },
		completeFiles: async (cwd, query) => { calls.push(`completeFiles:${cwd}:${String(query)}`); return state.files; },
		pushSessionView: (_index, _tab, force) => { calls.push(`pushSessionView:${force}`); },
		noteReadyDocument: (_tab, documentId) => { calls.push(`noteReadyDocument:${documentId}`); },
		activateNativeEditor: () => { calls.push("activateNativeEditor"); },
		switchSessionMode: async (...args) => { modeSwitches.push(args); },
		refreshGuestContext: () => { calls.push("refreshGuestContext"); },
		bridgeRouteOf: () => state.route,
		pinBridgeOrigin: (...args) => { calls.push("pinBridgeOrigin"); pinned.push(args); },
		redeliverBridgeBinding: async () => { calls.push("redeliverBridgeBinding"); },
		acknowledgeBridgeRoute: (tabId, panel) => { acknowledged.push({ kind: "route", tabId, panel }); },
		acknowledgeBridgeSecret: (tabId, panel) => { acknowledged.push({ kind: "secret", tabId, panel }); },
		isTerminalPanelType: type => type.startsWith("omp:terminal-") && type !== "omp:terminal-copy-reply",
		handleTerminalMessage: async (slot, parsed) => { terminalMessages.push({ slot, type: parsed.type }); },
		acceptTerminalCopy: async (tab, reply) => { terminalCopies.push({ tab, reply }); },
		controlRequest: async (...args) => { controlRequests.push(args); },
		log: message => { logged.push(message); },
		info: message => { infos.push(message); },
		warn: message => { warnings.push(message); },
		error: message => { errors.push(message); },
		...overrides,
	};
	const dispatcher = registerGuestDispatcher(deps);
	/** One editor of the fake window, with its panel. */
	const editor = (slot = SLOT, overrides: Partial<FakeTab> = {}, onPost?: OnPost): FakeEditor => {
		const page = fakePanel(onPost);
		const tab = tabRecord(slot, page.panel, overrides);
		state.tabs.set(slot, tab);
		return { tab, ...page };
	};
	return {
		state, dispatcher, deps, calls, logged, infos, warnings, errors, chatMessages, remembered, viewOnly, routesAttached, detailOpens,
		chatActions, terminalMessages, terminalCopies, modeSwitches, controlRequests, pinned, acknowledged, editor,
	};
}

const index = indexOf({ [TAB]: { cwd: "/work", sessionFile: "/work/s.jsonl", title: "Session" } });
const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
	stub.commands.calls.length = 0;
	stub.commands.handler = null;
});
afterEach(() => { mock.timers.reset(); });

describe("the gate on a page message", () => {
	it("ignores a message from a panel that no longer serves the slot, and one from a folder shell", async () => {
		const w = world();
		const live = w.editor();
		const stale = fakePanel();
		await w.dispatcher.handleMessage(index, SLOT, stale.panel, { type: "omp:focus-trace", detail: "stale" });
		await w.dispatcher.handleMessage(index, "unknown-slot", live.panel, { type: "omp:focus-trace", detail: "unknown" });
		w.editor(OTHER_SLOT, { tabId: null });
		await w.dispatcher.handleMessage(index, OTHER_SLOT, w.state.tabs.get(OTHER_SLOT)!.panel as never, { type: "omp:focus-trace", detail: "shell" });
		assert.deepEqual(w.logged, []);
	});

	it("logs a message the boundary does not recognize and dispatches nothing", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:nonsense" });
		await w.dispatcher.handleMessage(index, SLOT, live.panel, "text");
		assert.deepEqual(w.logged, [`slot ${SLOT}: ignored an unrecognized guest message`, `slot ${SLOT}: ignored an unrecognized guest message`]);
		assert.deepEqual(w.chatMessages, []);
	});

	it("ignores a terminal-vocabulary message a chat editor has no use for", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:terminal-visibility", visible: true });
		assert.deepEqual(w.terminalMessages, []);
		assert.deepEqual(w.logged, [`slot ${SLOT}: ignored a omp:terminal-visibility message from a chat editor`]);
	});
});

describe("each message reaches its owner", () => {
	it("sends chat commands to the conversation of the slot's tab with the panel's page", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:chat-abort", requestId: REQUEST });
		assert.equal(w.chatMessages.length, 1);
		assert.equal(w.chatMessages[0]!.tabId, TAB);
		assert.equal(w.chatMessages[0]!.message.type, "omp:chat-abort");
		assert.equal(w.chatMessages[0]!.page.id, `page-of-${SLOT}`);
	});

	it("sends a terminal link of a chat editor to the terminal and the terminal vocabulary of a terminal editor", async () => {
		const w = world();
		const chat = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, chat.panel, { type: "omp:terminal-link-validate", requestId: 1, target: "./a.ts" });
		assert.deepEqual(w.terminalMessages, [{ slot: SLOT, type: "omp:terminal-link-validate" }]);
		const terminal = w.editor(OTHER_SLOT, { mode: "terminal" });
		await w.dispatcher.handleMessage(index, OTHER_SLOT, terminal.panel, { type: "omp:terminal-visibility", visible: false });
		assert.deepEqual(w.terminalMessages.at(-1), { slot: OTHER_SLOT, type: "omp:terminal-visibility" });
	});

	it("hands a terminal copy reply to the terminal with the sending editor's record", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:terminal-copy-reply", requestId: HEX("b"), generation: null, text: "copied" });
		assert.equal(w.terminalCopies.length, 1);
		assert.equal(w.terminalCopies[0]!.tab, live.tab, "the reply is answered against the record of the editor that sent it");
		assert.equal(w.terminalCopies[0]!.reply.text, "copied");
	});

	it("asks for a session mode switch only once the extension has a context", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:session-mode", mode: "terminal" });
		assert.equal(w.modeSwitches.length, 1);
		assert.deepEqual([w.modeSwitches[0]![0], w.modeSwitches[0]![1], w.modeSwitches[0]![2], w.modeSwitches[0]![3]], [w.state.context, index, live.tab, "terminal"]);
		w.state.context = undefined as never;
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:session-mode", mode: "chat" });
		assert.equal(w.modeSwitches.length, 1);
	});

	it("runs a named chat action through the context, and the control request over the panel", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:chat-command", command: "compact" });
		assert.deepEqual(w.chatActions[0], [w.state.context, index, TAB, "compact"]);
		const request = { type: "omp:control-request", scope: SCOPE, requestId: 1, action: "snapshot" };
		await w.dispatcher.handleMessage(index, SLOT, live.panel, request);
		assert.equal(w.controlRequests.length, 1);
		assert.deepEqual([w.controlRequests[0]![0], w.controlRequests[0]![1], w.controlRequests[0]![3]], [index, TAB, live.panel]);
		assert.equal((w.controlRequests[0]![2] as { requestId: number }).requestId, 1);
		w.state.context = undefined as never;
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:chat-command", command: "shake" });
		assert.equal(w.chatActions.length, 1);
	});

	it("hands a bridge acknowledgement to the bridge only from the panel that serves the slot", async () => {
		const w = world();
		const live = w.editor();
		const stale = fakePanel();
		const route = { type: "omp:route-ack", hostGeneration: HEX("1"), documentId: HEX("2"), routeGeneration: HEX("3") };
		const secret = { type: "omp:bridge-ack", hostGeneration: HEX("1"), documentId: HEX("2"), bindingHash: "4".repeat(64) };
		await w.dispatcher.handleMessage(index, SLOT, stale.panel, route);
		await w.dispatcher.handleMessage(index, SLOT, stale.panel, secret);
		assert.deepEqual(w.acknowledged, [], "a panel the slot no longer shows cannot acknowledge for it");
		await w.dispatcher.handleMessage(index, SLOT, live.panel, route);
		await w.dispatcher.handleMessage(index, SLOT, live.panel, secret);
		assert.deepEqual(w.acknowledged, [{ kind: "route", tabId: TAB, panel: live.panel }, { kind: "secret", tabId: TAB, panel: live.panel }]);
	});

	it("traces focus into the log and keeps the popup flag of the tab in step with the page", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:focus-trace", detail: "composer" });
		assert.deepEqual(w.logged, [`tab ${TAB}: focus: composer`]);
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:composer-popup", open: true });
		assert.deepEqual([...w.state.popups], [TAB]);
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:composer-popup", open: false });
		assert.deepEqual([...w.state.popups], []);
		assert.deepEqual(w.calls, ["refreshGuestContext", "refreshGuestContext"]);
	});

	it("opens a detail tab for a chat editor and for none that cannot show it", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:open-detail", kind: "agent", agentId: "worker" });
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:open-detail", kind: "todo" });
		assert.deepEqual(w.detailOpens, [
			{ conversation: TAB, target: { kind: "agent", agentId: "worker" } },
			{ conversation: TAB, target: { kind: "todo" } },
		]);
		assert.deepEqual(w.logged, [`tab ${TAB}: detail tab agent was created`, `tab ${TAB}: detail tab todo was created`]);
		w.state.kind = "legacy";
		w.dispatcher.openDetailTab(TAB, "chat", { type: "omp:open-detail", kind: "agents" });
		w.state.kind = "live";
		w.dispatcher.openDetailTab(TAB, "terminal", { type: "omp:open-detail", kind: "agents" });
		assert.equal(w.detailOpens.length, 2);
	});
});

describe("file completions", () => {
	it("answers the page that asked with the paths below its session's folder", async () => {
		const w = world();
		const live = w.editor(SLOT, { runtime: { cwd: "/runtime" } });
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:complete-files", requestId: 7, query: "ab" });
		assert.deepEqual(w.calls, ["completeFiles:/runtime:ab"]);
		assert.deepEqual(live.posted, [{ type: "omp:file-completions", requestId: 7, paths: ["a.ts", "b/c.ts"] }]);
	});

	it("falls back to the row's folder, and stays silent without a folder or after the panel was replaced", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:complete-files", requestId: 1, query: "x" });
		assert.deepEqual(w.calls, ["completeFiles:/work:x"]);
		const orphan = world();
		const lone = orphan.editor();
		await orphan.dispatcher.handleMessage(indexOf({}), SLOT, lone.panel, { type: "omp:complete-files", requestId: 2, query: "x" });
		assert.deepEqual([orphan.calls, lone.posted], [[], []]);
		const tabs = new Map<string, FakeTab>();
		const replaced = world({ tabs: () => tabs, completeFiles: async () => { tabs.set(SLOT, tabRecord(SLOT, fakePanel().panel)); return ["a.ts"]; } });
		const gone = fakePanel();
		tabs.set(SLOT, tabRecord(SLOT, gone.panel, { runtime: { cwd: "/runtime" } }));
		await replaced.dispatcher.handleMessage(index, SLOT, gone.panel, { type: "omp:complete-files", requestId: 3, query: "x" });
		assert.deepEqual(gone.posted, []);
	});
});

describe("omp:ready", () => {
	it("sends the conversation fresh and shows saved history while nothing serves the tab", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		await nextTurn();
		assert.deepEqual(w.calls, ["pushSessionView:true", "noteReadyDocument:undefined", "activateNativeEditor", `attachChatRoute:${SLOT}:true`]);
		assert.deepEqual(w.viewOnly, [{ tabId: TAB, input: { file: "/work/s.jsonl", cwd: "/work", title: "Session", reason: "Restoring the session…", phase: "resyncing" } }]);
		assert.deepEqual(w.routesAttached, [[TAB, true]]);
	});

	it("shows no history for a tab with no file, a terminal editor, or a conversation that already exists", async () => {
		const noFile = world();
		const live = noFile.editor();
		await noFile.dispatcher.handleMessage(indexOf({ [TAB]: { cwd: "/work", sessionFile: null, title: null } }), SLOT, live.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		const terminal = world();
		const shell = terminal.editor(SLOT, { mode: "terminal" });
		await terminal.dispatcher.handleMessage(index, SLOT, shell.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		const served = world();
		served.state.kind = "live";
		const chat = served.editor();
		await served.dispatcher.handleMessage(index, SLOT, chat.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		await nextTurn();
		assert.deepEqual([noFile.viewOnly, terminal.viewOnly, served.viewOnly], [[], [], []]);
	});

	it("refuses a page of another protocol version with a reload notice and sends it nothing", async () => {
		const w = world();
		const live = w.editor();
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION + 1 });
		assert.deepEqual(w.calls, []);
		assert.equal(w.errors.length, 1);
		assert.match(w.errors[0]!, /different versions/);
		assert.deepEqual(w.logged, [`tab ${TAB}: guest protocol ${GUEST_PROTOCOL_VERSION + 1} != ${GUEST_PROTOCOL_VERSION}; the conversation was not sent`]);
	});

	it("pins the origin a page reports with its ticket and drops the report held for it", async () => {
		const w = world();
		const live = w.editor(SLOT, { heldReadyReport: { held: true } });
		await w.dispatcher.handleMessage(index, SLOT, live.panel, {
			type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION,
			editorId: HEX("1"), documentId: HEX("2"), bootstrapId: HEX("3"), origin: "vscode-webview://abc",
		});
		assert.equal(live.tab.heldReadyReport, null);
		assert.deepEqual(w.pinned, [[TAB, live.panel, { documentId: HEX("2"), bootstrapId: HEX("3"), origin: "vscode-webview://abc" }]]);
		assert.deepEqual(w.calls.slice(0, 3), ["pinBridgeOrigin", "redeliverBridgeBinding", "pushSessionView:true"]);
		assert.equal(w.calls[3], `noteReadyDocument:${HEX("2")}`);
	});
});

describe("the draft handoff", () => {
	const content = { text: "edited draft", attachments: 1, recoverable: [{ text: "pending", attachments: 2, unconfirmed: true }] };

	it("captures the draft the page answers with and holds nothing back when it is complete", async () => {
		const w = world();
		const live = w.editor(SLOT, {}, async message => {
			if (message.type === "omp:draft-request") {
				await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:draft-reply", requestId: message.requestId, captured: true, ...content });
			}
		});
		const carried = await w.dispatcher.captureDraft(live.tab);
		assert.ok(carried);
		assert.deepEqual({ text: carried.reply.text, attachments: carried.reply.attachments, recoverable: carried.reply.recoverable }, content);
		assert.equal(carried.source, live.tab);
		assert.equal(carried.panel, live.panel);
		assert.equal(carried.document, live.tab.document);
		assert.equal(carried.restoredDocument, null);
		assert.deepEqual(live.posted.map(message => message.type), ["omp:draft-request"]);
	});

	it("is not captured, and the page is told to unlock, when the page says it could not capture all of it", async () => {
		const w = world();
		const live = w.editor(SLOT, {}, async message => {
			if (message.type === "omp:draft-request") {
				await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:draft-reply", requestId: message.requestId, captured: false, text: "", attachments: 0, recoverable: [] });
			}
		});
		assert.equal(await w.dispatcher.captureDraft(live.tab), null);
		assert.deepEqual(live.posted.map(message => message.type), ["omp:draft-request", "omp:draft-release"]);
		assert.equal(live.posted[1]!.requestId, live.posted[0]!.requestId);
	});

	it("is not captured when the page cannot receive the request", async () => {
		const w = world();
		const live = w.editor();
		live.state.accept = false;
		assert.equal(await w.dispatcher.captureDraft(live.tab), null);
		assert.deepEqual(live.posted.map(message => message.type), ["omp:draft-request", "omp:draft-release"]);
	});

	it("is not captured within the bound when the page stays silent, or answers for another request or document", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const silent = world();
		const quiet = silent.editor();
		const waiting = silent.dispatcher.captureDraft(quiet.tab);
		await nextTurn();
		mock.timers.tick(1_500);
		assert.equal(await waiting, null);
		assert.deepEqual(quiet.posted.map(message => message.type), ["omp:draft-request", "omp:draft-release"]);

		const foreign = world();
		const page = foreign.editor(SLOT, {}, async message => {
			if (message.type !== "omp:draft-request") return;
			await foreign.dispatcher.handleMessage(index, SLOT, page.panel, { type: "omp:draft-reply", requestId: message.requestId! + 1, captured: true, ...content });
			page.tab.document = guestDocument();
			await foreign.dispatcher.handleMessage(index, SLOT, page.panel, { type: "omp:draft-reply", requestId: message.requestId, captured: true, ...content });
		});
		const asking = foreign.dispatcher.captureDraft(page.tab);
		await nextTurn();
		mock.timers.tick(1_500);
		assert.equal(await asking, null);
	});

	it("asks no page that shows no guest document", async () => {
		const w = world();
		const noPanel = w.editor(SLOT, { panel: null });
		const unavailable = w.editor(OTHER_SLOT, { document: { kind: "unavailable" } });
		assert.equal(await w.dispatcher.captureDraft(noPanel.tab), null);
		assert.equal(await w.dispatcher.captureDraft(unavailable.tab), null);
		assert.deepEqual(unavailable.posted, []);
	});

	it("cancels only the capture of a document that is still the one shown", async () => {
		const w = world();
		const live = w.editor();
		const carried = { reply: { requestId: 9 }, source: live.tab, panel: live.panel, document: live.tab.document, restoredDocument: null } as unknown as CarriedDraft<FakeTab>;
		w.dispatcher.releaseCarriedDraft(null);
		w.dispatcher.releaseCarriedDraft(carried);
		assert.deepEqual(live.posted, [{ type: "omp:draft-release", requestId: 9 }]);
		live.tab.document = guestDocument();
		w.dispatcher.releaseCarriedDraft(carried);
		assert.equal(live.posted.length, 1);
	});

	it("carries the draft of the panel being replaced, and says so when an image or the whole input is lost", async () => {
		const w = world();
		const live = w.editor(SLOT, {}, async message => {
			if (message.type === "omp:draft-request") {
				await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:draft-reply", requestId: message.requestId, captured: true, ...content });
			}
		});
		assert.equal(await w.dispatcher.carryDraftFrom(null), null);
		assert.equal(await w.dispatcher.carryDraftFrom(fakePanel().panel), null);
		const carried = await w.dispatcher.carryDraftFrom(live.panel);
		assert.equal(carried?.reply.text, "edited draft");
		assert.deepEqual(w.infos, ["3 images could not be carried to the replacement document. Their text is preserved; reattach them before sending."]);
		assert.deepEqual(w.warnings, []);

		const lost = world();
		const silent = lost.editor();
		silent.state.accept = false;
		assert.equal(await lost.dispatcher.carryDraftFrom(silent.panel), null);
		assert.deepEqual(lost.warnings, ["This editor's complete unsent input could not be captured before the editor was replaced, so it was not preserved."]);

		const terminal = world();
		const shell = terminal.editor(SLOT, { mode: "terminal" });
		assert.equal(await terminal.dispatcher.carryDraftFrom(shell.panel), null);
		assert.deepEqual(shell.posted, []);
	});

	it("puts the draft back once into the document that replaced its source, and only that request's acknowledgement consumes it", async () => {
		const w = world();
		const live = w.editor();
		const source = guestDocument();
		w.state.draftRestores.set(SLOT, {
			reply: { type: "omp:draft-reply", requestId: 5, captured: true, ...content }, source: live.tab, panel: live.panel, document: source, restoredDocument: null,
		} as never);
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		const restores = live.posted.filter(message => message.type === "omp:draft-restore");
		assert.equal(restores.length, 1);
		assert.deepEqual({ requestId: restores[0]!.requestId, text: restores[0]!.text, attachments: restores[0]!.attachments }, { requestId: 5, text: "edited draft", attachments: 1 });
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:draft-restored", requestId: 6 });
		assert.ok(w.state.draftRestores.has(SLOT), "a foreign acknowledgement cannot consume input");
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:draft-restored", requestId: 5 });
		assert.equal(w.state.draftRestores.has(SLOT), false);
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		assert.equal(live.posted.filter(message => message.type === "omp:draft-restore").length, 1);
	});

	it("does not put a draft back into the document it was captured from", async () => {
		const w = world();
		const live = w.editor();
		w.state.draftRestores.set(SLOT, {
			reply: { type: "omp:draft-reply", requestId: 5, captured: true, ...content }, source: live.tab, panel: live.panel, document: live.tab.document, restoredDocument: null,
		} as never);
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:ready", protocolVersion: GUEST_PROTOCOL_VERSION });
		assert.deepEqual(live.posted, []);
	});
});

describe("the symbol search from a chat page", () => {
	const selectionAnswering = (
		dispatcher: GuestDispatcher<FakeTab>, text: string, sender: () => { slot: string; panel: never },
	) => async (message: PostedMessage) => {
		if (message.type !== "omp:selection-request") return;
		const from = sender();
		await dispatcher.handleMessage(index, from.slot, from.panel, { type: "omp:selection-reply", requestId: message.requestId, text });
	};
	const activate = (state: { active: (FakeTab & { tabId: string; panel: never }) | null }, editor: FakeEditor) => {
		state.active = Object.assign(Object.create(null), editor.tab, { tabId: TAB, panel: editor.panel });
	};

	it("seeds the quick open with what the page selected", async () => {
		const w = world();
		const live = w.editor(SLOT, {}, selectionAnswering(w.dispatcher, "  Foo  ", () => ({ slot: SLOT, panel: w.state.tabs.get(SLOT)!.panel as never })));
		activate(w.state, live);
		await w.dispatcher.searchSymbolFromChat();
		assert.deepEqual(stub.commands.calls, [["workbench.action.quickOpen", "#Foo"]]);
	});

	it("opens the symbol search empty when the selection is empty, unanswered or answered by another editor", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const empty = world();
		const one = empty.editor(SLOT, {}, selectionAnswering(empty.dispatcher, "", () => ({ slot: SLOT, panel: empty.state.tabs.get(SLOT)!.panel as never })));
		activate(empty.state, one);
		await empty.dispatcher.searchSymbolFromChat();
		assert.deepEqual(stub.commands.calls, [["workbench.action.showAllSymbols"]]);

		stub.commands.calls.length = 0;
		const silent = world();
		const quiet = silent.editor();
		activate(silent.state, quiet);
		const waiting = silent.dispatcher.searchSymbolFromChat();
		await nextTurn();
		mock.timers.tick(500);
		await waiting;
		assert.deepEqual(stub.commands.calls, [["workbench.action.showAllSymbols"]]);

		stub.commands.calls.length = 0;
		const foreign = world();
		const other = foreign.editor(OTHER_SLOT);
		const asked = foreign.editor(SLOT, {}, selectionAnswering(foreign.dispatcher, "Foo", () => ({ slot: OTHER_SLOT, panel: other.panel })));
		activate(foreign.state, asked);
		const answered = foreign.dispatcher.searchSymbolFromChat();
		await nextTurn();
		mock.timers.tick(500);
		await answered;
		assert.deepEqual(stub.commands.calls, [["workbench.action.showAllSymbols"]]);
	});

	it("asks no terminal editor and no page when no OMP editor is in front", async () => {
		const w = world();
		const shell = w.editor(SLOT, { mode: "terminal" });
		activate(w.state, shell);
		await w.dispatcher.searchSymbolFromChat();
		w.state.active = null;
		await w.dispatcher.searchSymbolFromChat();
		assert.deepEqual(shell.posted, []);
		assert.deepEqual(stub.commands.calls, [["workbench.action.showAllSymbols"], ["workbench.action.showAllSymbols"]]);
	});

	it("ignores a selection reply nobody asked for, answered through the handle", async () => {
		const w = world();
		const live = w.editor();
		w.dispatcher.acceptSelectionReply(SLOT, live.panel, { type: "omp:selection-reply", requestId: 99, text: "Foo" });
		await w.dispatcher.handleMessage(index, SLOT, live.panel, { type: "omp:selection-reply", requestId: 99, text: "Foo" });
		assert.deepEqual(stub.commands.calls, []);
	});
});

describe("running a chat command", () => {
	const prompt = { type: "omp:chat-prompt", requestId: REQUEST, text: "hello" } as never;
	const page = { id: "page", posted: [] as unknown[], post(message: unknown) { this.posted.push(message); return "sent"; } };

	beforeEach(() => { page.posted.length = 0; });

	it("answers an accepted prompt to its page with the conversation's epoch and remembers its text", async () => {
		const w = world();
		assert.equal(await w.dispatcher.runChatCommand(TAB, prompt, page as never), "accepted");
		assert.deepEqual(page.posted, [{ type: "omp:chat-send-result", epoch: w.state.epoch, requestId: REQUEST, status: "accepted" }]);
		assert.deepEqual(w.remembered, ["hello"]);
		assert.deepEqual(w.logged, []);
	});

	it("reports each other outcome of a send with its own status and logs it", async () => {
		const w = world();
		for (const [outcome, status] of [["explained", "explained"], ["unconfirmed", "unconfirmed"], ["refused", "refused"], ["ignored", "refused"]] as const) {
			page.posted.length = 0;
			w.state.outcome = outcome;
			assert.equal(await w.dispatcher.runChatCommand(TAB, prompt, page as never), outcome);
			assert.deepEqual((page.posted[0] as { status: string }).status, status);
		}
		assert.deepEqual(w.remembered, []);
		assert.equal(w.logged.length, 4);
		assert.equal(w.logged[0], `tab ${TAB}: omp:chat-prompt ${REQUEST.slice(0, 8)} was explained`);
	});

	it("reports a send whose channel failed as unconfirmed, but lets another command's failure through", async () => {
		const w = world();
		w.state.handleMessageThrows = true;
		assert.equal(await w.dispatcher.runChatCommand(TAB, prompt, page as never), "unconfirmed");
		assert.equal((page.posted[0] as { status: string }).status, "unconfirmed");
		await assert.rejects(w.dispatcher.runChatCommand(TAB, { type: "omp:chat-abort", requestId: REQUEST } as never, page as never), /channel failed/);
	});

	it("logs a stop even when it was accepted, and sends no result for a command that is not a send", async () => {
		const w = world();
		await w.dispatcher.runChatCommand(TAB, { type: "omp:chat-abort", requestId: REQUEST } as never, page as never);
		assert.deepEqual(page.posted, []);
		assert.deepEqual(w.logged, [`tab ${TAB}: omp:chat-abort ${REQUEST.slice(0, 8)} was accepted`]);
	});

	it("sends no result when the conversation has no state, and tells the page a refused send through the handle", async () => {
		const w = world();
		w.state.epoch = undefined;
		await w.dispatcher.runChatCommand(TAB, prompt, page as never);
		assert.deepEqual(page.posted, []);
		w.state.epoch = { nonce: "m", counter: 1 };
		w.dispatcher.replyChatSendResult(TAB, prompt, page as never, "refused");
		assert.deepEqual(page.posted, [{ type: "omp:chat-send-result", epoch: w.state.epoch, requestId: REQUEST, status: "refused" }]);
	});
});

describe("a tab without a live conversation", () => {
	it("shows the saved history read-only with the reason and then sends it to every page of the tab", async () => {
		const w = world();
		w.dispatcher.presentUnavailable(index, TAB, "The host is gone");
		w.dispatcher.presentUnavailable(index, TAB, "Another process holds it", "blocked");
		await nextTurn();
		assert.deepEqual(w.viewOnly.map(call => [call.input.reason, call.input.phase, call.input.file]), [
			["The host is gone", "view-only", "/work/s.jsonl"],
			["Another process holds it", "blocked", "/work/s.jsonl"],
		]);
		assert.deepEqual(w.routesAttached, [[TAB, true], [TAB, true]]);
	});

	it("presents nothing for a tab the index no longer knows", async () => {
		const w = world();
		w.dispatcher.presentUnavailable(indexOf({}), TAB, "gone");
		await nextTurn();
		assert.deepEqual([w.viewOnly, w.routesAttached], [[], []]);
	});
});

describe("stale host-control facts", () => {
	it("tells the panel that holds the tab to read them again", () => {
		const w = world();
		const live = w.editor();
		w.dispatcher.invalidateControls(TAB);
		assert.deepEqual(live.posted, [{ type: "omp:control-invalidate" }]);
	});

	it("tells an orphan over the route it has, and an editor that is gone nothing", () => {
		const invalidations: unknown[][] = [];
		const w = world();
		w.state.route = { routeGeneration: "route-1" };
		w.editor(SLOT, { panel: null, bridge: { documentId: "doc-1", endpoint: { invalidateRoute: (...args: unknown[]) => { invalidations.push(args); } } } });
		w.dispatcher.invalidateControls(TAB);
		assert.deepEqual(invalidations, [["doc-1", "route-1"]]);
		const bare = world();
		bare.state.route = { routeGeneration: "route-1" };
		bare.dispatcher.invalidateControls(TAB);
		const unrouted = world();
		const orphan = unrouted.editor(SLOT, { panel: null, bridge: { documentId: "doc-1", endpoint: { invalidateRoute: () => assert.fail("no route") } } });
		unrouted.dispatcher.invalidateControls(TAB);
		assert.equal(orphan.posted.length, 0);
	});
});

describe("the detail tabs of a previous host lifetime", () => {
	it("closes every detail tab, whether it carries its own view type or the bridge's prefix, and no other", async () => {
		const closed: unknown[][] = [];
		const close = stub.window.tabGroups.close;
		stub.window.tabGroups.close = async (...args: unknown[]) => { closed.push(args); return true; };
		const all = stub.window.tabGroups.all;
		try {
			const detail = { label: "detail", input: new stub.TabInputWebview(DETAIL_VIEW_TYPE) };
			const prefixed = { label: "bridged", input: new stub.TabInputWebview(`${TAB_INPUT_VIEW_TYPE_PREFIX}${DETAIL_VIEW_TYPE}`) };
			const session = { label: "session", input: new stub.TabInputWebview("omp.session") };
			const text = { label: "text", input: new stub.TabInputText(stub.Uri.file("/a")) };
			stub.window.tabGroups.all = [{ viewColumn: 1, tabs: [detail, session, text], activeTab: undefined }, { viewColumn: 2, tabs: [prefixed], activeTab: undefined }] as never;
			await registerGuestDispatcher(world().deps).closeLeftoverDetailTabs();
			assert.deepEqual(closed, [[[detail, prefixed], true]]);
			closed.length = 0;
			stub.window.tabGroups.all = [{ viewColumn: 1, tabs: [session, text], activeTab: undefined }] as never;
			await registerGuestDispatcher(world().deps).closeLeftoverDetailTabs();
			assert.deepEqual(closed, []);
		} finally {
			stub.window.tabGroups.close = close;
			stub.window.tabGroups.all = all;
		}
	});
});
