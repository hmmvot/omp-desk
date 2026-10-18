/**
 * The contribution contract: what `package.json` promises the editor against what the extension does at runtime.
 *
 * A menu entry, keybinding or welcome link that names a command nobody registered says "command not found"; a
 * `viewItem` clause that no row ever satisfies hides a context menu without any error; a view with no provider
 * stays empty. None of those is visible to a unit test of one module, so this file activates the real extension
 * bundle against a recording `vscode` (`vscode-recording-stub.ts`, in a temporary storage folder and with no OMP
 * installation to find) and compares what it registered with what `package.json` contributes, and it builds the
 * rows of every tree from the real providers to compare their `contextValue`s with the menu clauses.
 *
 * Rules the cases hold the contributions to:
 * - every command a menu, keybinding or welcome link names is declared in `contributes.commands`, with a title;
 * - every declared command is registered once at runtime (a declared command that is not is a dead menu item);
 * - a registered command that is not declared is allowed only when a tree row runs it on click (`ompDesk.clickSession`);
 * - every `view == <id>` names a contributed view, in a contributed container, that the extension gave a provider;
 * - every `viewItem` clause matches a `contextValue` its view's tree produces, and every produced `contextValue`
 *   has a menu entry unless it is one of the rows that only open on click;
 * - a command hidden from the palette (`when: false`) is reachable another way, because it needs a row or an
 *   editor to act on; and every palette-visible command runs without an argument without throwing.
 *
 * The tree modules load `vscode` through `src/views/vscode-test-stub.ts`; the hook below is limited to files under
 * `src/`, so the activated bundle (in the temporary folder) keeps its own recording module.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import module from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_TEXT_MENU_CONTEXT, CHAT_TEXT_MENU_KEY } from "../shared/quote-menu.ts";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import { build } from "esbuild";
import { URI } from "vscode-uri";

import type { BrokerProcessRow, BrokerProcessSnapshot } from "../host/broker-processes.ts";
import type { SessionIndexEntry } from "../host/session-model.ts";
import type { LauncherFolder } from "../views/launcher-folders.ts";
import type { SessionActivityFacts, SessionLauncherFacts, SessionTreeProvider } from "../views/session-tree.ts";
import { LEGACY_ALIASES, LEGACY_COMMAND_IDS, LEGACY_CONTEXT_KEYS, legacyCommandTarget } from "./legacy-aliases.ts";
import { LEGACY_SETTING_NAMES } from "./legacy-settings.ts";
import { createRecordingVscode } from "./vscode-recording-stub.ts";
import type { Recording } from "./vscode-recording-stub.ts";

// The tree modules import the editor API; map it before their first import (a static import would be evaluated first).
if (typeof module.registerHooks === "function") {
	const stubUrl = new URL("../views/vscode-test-stub.ts", import.meta.url).href;
	const EXTENSIONLESS = /^\.(?!.*\.[cm]?[jt]sx?$)/;
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			const fromSource = (context.parentURL ?? "").includes("/src/");
			if (specifier === "vscode" && fromSource) return { url: stubUrl, shortCircuit: true };
			if (EXTENSIONLESS.test(specifier) && fromSource) {
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

const sessionTree = await import("../views/session-tree.ts");
const { ContextTreeProvider } = await import("../views/context-tree.ts");
const { InventoryTreeProvider } = await import("../views/inventory-tree.ts");
const { projectContext } = await import("../host/context/context-model.ts");
const { projectView } = await import("../host/inventory/inventory-model.ts");

// ---------------------------------------------------------------------------------------------------------------
// package.json, as the editor reads it
// ---------------------------------------------------------------------------------------------------------------

interface MenuEntry { readonly command?: string; readonly submenu?: string; readonly when?: string; readonly group?: string }
interface CommandDeclaration { readonly command: string; readonly title?: string; readonly icon?: string; readonly category?: string }
interface ViewDeclaration { readonly id: string; readonly type?: string }
interface PackageJson {
	readonly contributes: {
		readonly commands: readonly CommandDeclaration[];
		readonly menus: Readonly<Record<string, readonly MenuEntry[]>>;
		readonly keybindings: readonly { readonly command: string; readonly key?: string; readonly when?: string }[];
		readonly views: Readonly<Record<string, readonly ViewDeclaration[]>>;
		readonly viewsContainers: Readonly<Record<string, readonly { readonly id: string }[]>>;
		readonly viewsWelcome: readonly { readonly view: string; readonly when?: string; readonly contents: string }[];
		readonly configuration: { readonly properties: Readonly<Record<string, unknown>> };
		readonly configurationDefaults: Readonly<Record<string, readonly string[]>>;
	};
}
const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as PackageJson;
const contributes = manifest.contributes;

const declared = new Map(contributes.commands.map(command => [command.command, command]));
const views = Object.values(contributes.views).flat();
const viewIds = new Set(views.map(view => view.id));
const palette = contributes.menus.commandPalette ?? [];
const hiddenFromPalette = new Set(palette.filter(entry => entry.when === "false").map(entry => entry.command ?? ""));
const menus = Object.entries(contributes.menus).flatMap(([menu, entries]) => entries.map((entry, at) => ({ menu, at, entry })));

/** Name an entry so a failure points at the line of `package.json` to change. */
function where(menu: string, entry: MenuEntry): string {
	return `${menu} entry ${entry.command ?? entry.submenu ?? "(neither command nor submenu)"} [${entry.group ?? "no group"}] when "${entry.when ?? ""}"`;
}

/** A `viewItem` condition of a `when` clause; the clauses this extension writes are a conjunction with one such atom. */
function viewItemTest(when: string, owner: string): { readonly view: string | null; readonly matches: ((contextValue: string) => boolean) | null } {
	const withoutRegex = when.replace(/=~\s*\/(?:\\.|[^/\\])*\/[a-z]*/g, "=~ REGEX");
	assert.ok(!/\|\||[()]/.test(withoutRegex) || !/\bviewItem\b/.test(when), `${owner}: this contract reads conjunctions only`);
	const view = /(?:^|&&)\s*view\s*==\s*([\w.]+)/.exec(when)?.[1] ?? null;
	const pattern = /\bviewItem\s*=~\s*\/((?:\\.|[^/\\])*)\/([a-z]*)/.exec(when);
	if (pattern !== null) {
		const regex = new RegExp(pattern[1] ?? "", pattern[2] ?? "");
		return { view, matches: value => regex.test(value) };
	}
	const literal = /\bviewItem\s*==\s*([\w.]+)/.exec(when)?.[1];
	if (literal !== undefined) return { view, matches: value => value === literal };
	assert.ok(!/\bviewItem\b/.test(when), `${owner}: a viewItem condition this contract cannot read`);
	return { view, matches: null };
}

// ---------------------------------------------------------------------------------------------------------------
// The activated extension
// ---------------------------------------------------------------------------------------------------------------

interface ExtensionModule {
	activate(context: unknown): Promise<void>;
	deactivate(): void;
}
interface ActivationContext {
	readonly subscriptions: { dispose(): void }[];
}

let root = "";
let recording: Recording;
let extension: ExtensionModule;
let context: ActivationContext;
const savedEnvironment = new Map<string, string | undefined>();

function memento() {
	const values = new Map<string, unknown>();
	return {
		get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
		update: async (key: string, value: unknown) => { values.set(key, value); },
		keys: () => [...values.keys()],
		setKeysForSync() {},
	};
}

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-contributions-"));
	const entry = fileURLToPath(new URL("../extension.ts", import.meta.url));
	const bundle = path.join(root, "out", "extension.js");
	// The shipped bundle's own configuration, with `vscode` left for the host to provide.
	await build({
		entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node20",
		external: ["vscode"], logLevel: "silent", logOverride: { "empty-import-meta": "silent" },
	});
	// `require("vscode")` from the bundle resolves to this folder and so to the recording module.
	await mkdir(path.join(root, "node_modules", "vscode"), { recursive: true });
	await writeFile(path.join(root, "node_modules", "vscode", "index.js"), "module.exports = globalThis.__ompContributionVscode;");
	const home = path.join(root, "home");
	await mkdir(home, { recursive: true });
	for (const [name, value] of [["USERPROFILE", home], ["HOME", home], ["PI_CODING_AGENT_DIR", path.join(home, "agent")]] as const) {
		savedEnvironment.set(name, process.env[name]);
		process.env[name] = value;
	}
	// No OMP to find: nothing the handlers do can start the user's installed OMP or Bun.
	const created = createRecordingVscode({ "ompDesk.executablePath": path.join(root, "no-such-omp.exe") });
	recording = created.recording;
	(globalThis as Record<string, unknown>).__ompContributionVscode = created.vscode;
	extension = module.createRequire(bundle)(bundle) as ExtensionModule;
	const extensionFolder = path.join(root, "extension");
	const storage = path.join(root, "global-storage");
	await mkdir(extensionFolder, { recursive: true });
	await mkdir(storage, { recursive: true });
	context = {
		extensionMode: 3, extensionUri: URI.file(extensionFolder), extensionPath: extensionFolder, globalStorageUri: URI.file(storage),
		storageUri: undefined, subscriptions: [], workspaceState: memento(), globalState: memento(),
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }, extension: { id: "test.omp-desk" },
	} as ActivationContext;
	await extension.activate(context);
	// The catalog pass finishes after `activate` returns and registers its watchers when it does; tearing down before
	// it ends would leave a watcher no one disposes.
	await recording.contextSet("ompDesk.catalogPending", false);
	await nextTurn();
	await nextTurn();
});

after(async () => {
	for (let subscription = context?.subscriptions.pop(); subscription !== undefined; subscription = context.subscriptions.pop()) subscription.dispose();
	extension?.deactivate();
	for (const [name, value] of savedEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------------------------------------------
// The rows every tree produces
// ---------------------------------------------------------------------------------------------------------------

interface ProducedRow { readonly contextValue: string | undefined; readonly command: string | undefined }

const ALPHA = path.join(tmpdir(), "omp-contributions", "alpha");
const FILE = path.join(tmpdir(), "omp-contributions", "session.jsonl");
const NO_FACTS: SessionLauncherFacts = { open: false, running: false, outcome: null, activity: null };
const providers: InstanceType<typeof SessionTreeProvider>[] = [];
after(() => { for (const provider of providers) provider.dispose(); });

function sessionEntry(overrides: Partial<SessionIndexEntry>): SessionIndexEntry {
	return {
		tabId: "tab:row", cwd: ALPHA, kind: "session", origin: "extension", sessionFile: FILE, sessionId: null, scope: { profile: null, sessionDir: null },
		sessionDir: null, ownership: null, host: null, createdAt: "2026-09-25T10:00:00.000Z", lastActiveAt: "2026-09-25T10:05:00.000Z", ordinal: 0,
		availability: "saved", detail: null, runIntent: "stopped", title: null, lastCompletedReplyId: null, lastSeenReplyId: null, ...overrides,
	};
}
const activity = (overrides: Partial<SessionActivityFacts>): SessionActivityFacts => ({
	pendingQuestion: false, working: false, backgroundWork: false, settled: true, trailingQuestion: false, lastCompletedReplyId: null, lastSeenReplyId: null, ...overrides,
});

/** Session rows over the situations a row can be in: the real classifier names each one's state, the real row builds its `contextValue`. */
function sessionRows(): { state: string; row: ProducedRow }[] {
	const stopped = sessionEntry({});
	const draft = sessionEntry({ kind: "draft", sessionFile: null, availability: "draft" });
	const live = sessionEntry({ availability: "live", runIntent: "running" });
	const liveDraft = sessionEntry({ kind: "draft", sessionFile: null, availability: "live", runIntent: "running" });
	const attached = (viewMode: "chat" | "terminal" | null, activityFacts: SessionActivityFacts | null = null): SessionLauncherFacts =>
		({ ...NO_FACTS, running: true, open: viewMode !== null, viewMode, activity: activityFacts });
	const scenarios: readonly { entry: SessionIndexEntry; facts: SessionLauncherFacts }[] = [
		{ entry: stopped, facts: NO_FACTS },
		{ entry: stopped, facts: { ...NO_FACTS, ownershipChecked: true } },
		{ entry: draft, facts: NO_FACTS },
		{ entry: live, facts: attached("chat") },
		{ entry: live, facts: attached("terminal") },
		{ entry: live, facts: attached(null) },
		{ entry: liveDraft, facts: attached("chat") },
		{ entry: live, facts: attached("chat", activity({ pendingQuestion: true })) },
		{ entry: live, facts: attached("chat", activity({ working: true })) },
		{ entry: live, facts: attached("chat", activity({ backgroundWork: true })) },
		{ entry: live, facts: attached("chat", activity({ settled: false })) },
		{ entry: live, facts: attached("chat", activity({ lastCompletedReplyId: "reply-1" })) },
		{ entry: live, facts: attached("chat", activity({})) },
		{ entry: live, facts: { ...NO_FACTS, ownedWriterPid: 4242, ownershipChecked: true } },
		{ entry: live, facts: { ...NO_FACTS, heldElsewhere: true, switchableWindow: true } },
		{ entry: live, facts: { ...NO_FACTS, heldElsewhere: true, switchableWindow: false } },
		{ entry: stopped, facts: { ...NO_FACTS, externalOmp: true, ownershipChecked: true } },
		{ entry: sessionEntry({ availability: "failed" }), facts: NO_FACTS },
		{ entry: live, facts: { ...NO_FACTS, restoring: true } },
		{ entry: live, facts: { ...NO_FACTS, launching: true } },
		{ entry: live, facts: { ...attached("chat"), stopping: true } },
		{ entry: live, facts: { ...NO_FACTS, checking: true } },
	];
	return scenarios.map(({ entry, facts }) => {
		const state = sessionTree.sessionItemState(entry, facts);
		const item = new sessionTree.SessionTreeItem(entry, state, { header: null, conversation: { lastAt: null }, facts, active: false, now: 0 });
		return { state, row: { contextValue: item.contextValue, command: item.command?.command } };
	});
}

const folderRow = (id: string, folderPath: string, flags: { pinned: boolean; collapsed: boolean }): LauncherFolder =>
	({ id, path: folderPath, collapsed: flags.collapsed, pinned: flags.pinned, open: false, openHere: false, openElsewhere: false });

/** Every node a session provider serves in one layout, folders and their children included. */
async function walk(provider: InstanceType<typeof SessionTreeProvider>): Promise<ProducedRow[]> {
	const produced: ProducedRow[] = [];
	const visit = async (items: readonly object[]): Promise<void> => {
		for (const item of items) {
			const node = item as { contextValue?: string; command?: { command: string } };
			produced.push({ contextValue: node.contextValue, command: node.command?.command });
			const children = await provider.getChildren(item as never);
			if (children.length > 0) await visit(children);
		}
	};
	await visit(await provider.getChildren());
	return produced;
}

let serial = 0;
function processRow(overrides: Partial<BrokerProcessRow>): BrokerProcessRow {
	serial += 1;
	return {
		id: `current|tab:${serial}|pty-${serial}`, source: "current", kind: "terminal", ptyKind: "folder-shell", slot: `tab:${serial}`, brokerId: `pty-${serial}`,
		generation: `gen-${serial}`, brokerPid: 7000 + serial, brokerCreationTime: "134349421014308869", startedAt: "2026-09-25T10:00:00.000Z", uptimeMs: 60_000,
		title: null, status: "in-use", host: { kind: "terminal", folder: ALPHA, label: "alpha", window: "this-window" }, window: "this-window", drivenHere: false,
		child: "running", olderBuild: false, stop: { available: true }, ...overrides,
	};
}
/** Background processes of every kind, status and stop availability the Sessions view can list. */
function processRows(): BrokerProcessRow[] {
	const rows: BrokerProcessRow[] = [];
	for (const status of ["in-use", "orphaned", "unknown"] as const) {
		for (const stop of [{ available: true }, { available: false, reason: "previous version" }] as const) {
			for (const source of ["current", "predecessor"] as const) {
				rows.push(processRow({ status, stop, source }));
				rows.push(processRow({ status, stop, source, kind: "session", ptyKind: "managed-rpc", drivenHere: true,
					host: { kind: "session", tabId: `tab:p${serial}`, title: "Fix the build", folder: ALPHA, window: "this-window", drivenHere: true, recorded: true } }));
				rows.push(processRow({ status, stop, source, kind: "session", ptyKind: "managed-rpc", host: null, title: "left over" }));
				rows.push(processRow({ status, stop, source, kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "this-window" } }));
			}
		}
	}
	return rows;
}

/** Rows of the Sessions tree in every layout, with folders of every flavour, session rows and background processes. */
async function sessionsViewRows(): Promise<ProducedRow[]> {
	const folders: LauncherFolder[] = [];
	for (const pinned of [true, false]) {
		for (const collapsed of [true, false]) {
			for (const shells of [true, false]) folders.push(folderRow(`folder:${pinned}-${collapsed}-${shells}`, path.join(ALPHA, shells ? "shells" : "plain", `${pinned}-${collapsed}`), { pinned, collapsed }));
		}
	}
	const sessions = sessionRows();
	const entries = sessions.map((_, at) => sessionEntry({ tabId: `tab:${at}`, cwd: folders[at % folders.length]!.path }));
	const rows: ProducedRow[] = sessions.map(item => item.row);
	for (const grouping of ["flat", "folders", "terminals"] as const) {
		const provider = new sessionTree.SessionTreeProvider({
			folders: () => folders, entries: () => entries, activeTabId: () => null, facts: () => NO_FACTS, grouping: () => grouping,
			runtimeIdentity: () => null, observeOwnership: async () => ({}), hasRecoverableShell: folder => folder.path.includes(`${path.sep}shells${path.sep}`),
		});
		providers.push(provider);
		const snapshot: BrokerProcessSnapshot = { rows: processRows(), hidden: 0, unreadable: 0, takenAt: 0 };
		provider.setProcesses(snapshot);
		rows.push(...await walk(provider));
	}
	// The two rows the provider shows only for an empty folder and for a default profile with no provider login.
	const emptyFolder = new sessionTree.WorkspaceFolderTreeItem(folders[0]!, []);
	for (const item of [new sessionTree.EmptySessionTreeItem(emptyFolder), new sessionTree.ProviderLoginTreeItem()]) {
		rows.push({ contextValue: item.contextValue, command: item.command?.command });
	}
	return rows;
}

/** The Context view's rows from the real projection of a live Chat's context report. */
function contextViewRows(): ProducedRow[] {
	const provider = new ContextTreeProvider();
	const model = projectContext({
		subject: { title: "Work", mode: "chat", running: true },
		live: { model: { provider: "anthropic", id: "sonnet", name: "Sonnet", contextWindow: 200_000 }, usage: { tokens: 76_800, contextWindow: 200_000, percent: 38.4 }, busy: false, rewriting: false, maintenance: null },
		read: {
			at: 0, autoCompaction: true,
			stats: { userMessages: 4, assistantMessages: 4, toolCalls: 9, toolResults: 9, totalMessages: 26, premiumRequests: 0, tokens: { input: 150_000, output: 12_000, reasoning: 0, cacheRead: 90_000, cacheWrite: 0 } },
			files: { files: [{ path: path.join(ALPHA, "AGENTS.md"), chars: 1234 }], onDemand: [path.join(ALPHA, "src", "AGENTS.md")] },
			journal: { cost: 1.2, compactionCount: 2, lastCompaction: { timestamp: "2026-10-12T10:00:00.000Z", method: "soft", tokensBefore: 384_000, tokensAfter: 120_000, warning: null }, clearCount: 1, lastClear: "2026-10-11T12:00:00.000Z" },
		},
		report: null, now: Date.parse("2026-10-12T12:00:00.000Z"),
	});
	provider.setModel(model);
	return provider.getChildren().flatMap(group => [group, ...provider.getChildren(group)]).map(item => ({ contextValue: item.contextValue, command: item.command?.command }));
}

/** One inventory view's rows, switchable and read-only, in both scopes. */
function inventoryViewRows(kind: "skills" | "tools" | "mcp" | "extensions"): ProducedRow[] {
	const rowOf = (name: string, rowKind: string, switchable: boolean) => ({
		kind: rowKind, name, description: null, path: path.join(ALPHA, name), provider: "native", providerName: "OMP", level: "user", state: "active", shadowed: false, shadowedBy: null,
		disabledReason: null, detail: null, toolPrefix: null, runtimeName: null, sources: [],
		toggle: switchable ? { mechanism: "disabledExtensions", refusal: null } : { mechanism: null, refusal: "managed by the OMP installation" },
	});
	const inventory = {
		rows: ["skill", "builtin-tool", "custom-tool", "mcp", "extension-module", "plugin"].flatMap(rowKind => [rowOf(`${rowKind}-on`, rowKind, true), rowOf(`${rowKind}-fixed`, rowKind, false)]),
		cwd: ALPHA, profile: "default", projectOverridesDisabledExtensions: false, incomplete: [], incompleteReasons: [], disabledProviders: [],
	} as unknown as Parameters<typeof projectView>[0]["inventory"];
	const provider = new InventoryTreeProvider();
	provider.setModel(projectView({ view: kind, scope: "global", inventory, evidence: null, profile: "default" }));
	return provider.getChildren().flatMap(group => [group, ...provider.getChildren(group)]).map(item => ({ contextValue: item.contextValue, command: item.command?.command }));
}

/** The tree behind each contributed view id: what its rows can be. */
async function producedByView(): Promise<Map<string, ProducedRow[]>> {
	return new Map([
		["ompDesk.sessions", await sessionsViewRows()],
		["ompDesk.context", contextViewRows()],
		["ompDesk.skills", inventoryViewRows("skills")],
		["ompDesk.tools", inventoryViewRows("tools")],
		["ompDesk.mcp", inventoryViewRows("mcp")],
		["ompDesk.extensions", inventoryViewRows("extensions")],
	]);
}

/**
 * Rows whose only interaction is the click (or checkbox) they carry; they need no menu entry. Everything else a tree
 * produces must be matched by a `view/item/context` clause, so a renamed `contextValue` cannot drop a menu silently.
 */
const CLICK_ONLY_ROWS = new Set(["ompNewSession", "ompResumeSession", "ompTerminalsGroup", "inventory.switchable", "inventory.readonly"]);

// ---------------------------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------------------------

describe("commands", () => {
	it("are declared, with a title, for every menu entry, keybinding, palette entry and welcome link that names one", () => {
		const named: { by: string; command: string }[] = [];
		for (const { menu, entry } of menus) {
			assert.ok(entry.command !== undefined || entry.submenu !== undefined, `${where(menu, entry)}: names no command`);
			if (entry.command !== undefined) named.push({ by: where(menu, entry), command: entry.command });
		}
		for (const binding of contributes.keybindings) named.push({ by: `keybinding ${binding.command} when "${binding.when ?? ""}"`, command: binding.command });
		for (const welcome of contributes.viewsWelcome) {
			for (const link of welcome.contents.matchAll(/\(command:([\w.]+)\)/g)) named.push({ by: `viewsWelcome of ${welcome.view}: "${link[0]}"`, command: link[1] ?? "" });
		}
		const missing = named.filter(use => !declared.has(use.command)).map(use => `${use.command} (${use.by})`);
		assert.deepEqual(missing, [], "named but not declared in contributes.commands");
		const untitled = contributes.commands.filter(command => (command.title ?? "").trim() === "").map(command => command.command);
		assert.deepEqual(untitled, [], "declared without a title");
	});

	it("have an icon wherever a menu shows them as a button", () => {
		const iconless: string[] = [];
		for (const { menu, entry } of menus) {
			const asButton = (menu === "view/title" || menu === "editor/title") && /^navigation(@|$)/.test(entry.group ?? "")
				|| menu === "view/item/context" && /^inline(@|$)/.test(entry.group ?? "");
			if (asButton && entry.command !== undefined && declared.get(entry.command)?.icon === undefined) iconless.push(where(menu, entry));
		}
		assert.deepEqual(iconless, [], "shown as a toolbar or inline button without an icon");
	});

	it("are registered at runtime, once each, and only the row commands and the legacy aliases are registered without a declaration", async () => {
		const rowCommands = new Set([...(await producedByView()).values()].flat().flatMap(row => (row.command === undefined ? [] : [row.command])));
		assert.deepEqual(recording.duplicateCommands, [], "registered twice (the editor refuses the second registration)");
		const unregistered = [...declared.keys()].filter(id => !recording.commands.has(id));
		assert.deepEqual(unregistered, [], "declared in package.json but never registered: a menu item or palette entry that says 'command not found'");
		const aliases = new Set(LEGACY_ALIASES.map(([oldId]) => oldId));
		const undeclared = [...recording.commands.keys()].filter(id => !declared.has(id) && !rowCommands.has(id) && !aliases.has(id));
		assert.deepEqual(undeclared, [], "registered without a declaration and not run by any row's click: declare it or drop it");
		const unregisteredRowCommands = [...rowCommands].filter(id => !recording.commands.has(id));
		assert.deepEqual(unregisteredRowCommands, [], "run by a tree row's click but never registered");
	});

	it("bind Ctrl+N and Ctrl+Shift+N inside a Chat only, under the one condition, to the symbol search and Go to File seeded from its selection", () => {
		const bound = (key: string) => contributes.keybindings.filter(binding => binding.key === key);
		assert.deepEqual(bound("ctrl+n").map(binding => binding.command), ["ompDesk.searchSymbolFromChat"]);
		assert.deepEqual(bound("ctrl+shift+n").map(binding => binding.command), ["ompDesk.searchFileFromChat"]);
		const chatOnly = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
		assert.equal(bound("ctrl+n")[0]?.when, chatOnly);
		assert.equal(bound("ctrl+shift+n")[0]?.when, chatOnly);
		assert.equal(declared.get("ompDesk.searchFileFromChat")?.title, "Go to File from Chat Selection");
	});

	it("bind Ctrl+F (Cmd+F on macOS) to Find in Chat inside a Chat only, under the one condition, with no other binding on the key, and register the command to post the action", () => {
		const chatOnly = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
		assert.deepEqual(contributes.keybindings.filter(binding => binding.key === "ctrl+f").map(binding => [binding.command, binding.when]), [["ompDesk.findInChat", chatOnly]],
			"the key reaches the page through VS Code's own keybinding resolution, which reads the physical key on any keyboard layout");
		assert.equal((contributes.keybindings.find(binding => binding.command === "ompDesk.findInChat") as { mac?: string } | undefined)?.mac, "cmd+f");
		assert.equal(declared.get("ompDesk.findInChat")?.title, "Find in Chat");
		assert.deepEqual(menus.filter(({ menu, entry }) => menu === "editor/title" && entry.command === "ompDesk.findInChat").map(({ entry }) => entry.when), [chatOnly]);
		const source = readFileSync(new URL("../extension.ts", import.meta.url), "utf8");
		assert.match(source, /registerDeskCommand\("ompDesk\.findInChat", \(\) => findInChat\(\)\)/);
	});

	it("declare Quote Selection with Alt+Q inside a Chat, and Quote Selection to Session with Alt+Q in a text editor with a selection, no third binding on the key, and a transcript context menu item gated by the key the page sets", () => {
		const chatOnly = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
		const bound = contributes.keybindings.filter(binding => binding.key === "alt+q");
		assert.deepEqual(bound.map(binding => [binding.command, binding.when]), [
			["ompDesk.quoteChatSelection", chatOnly],
			["ompDesk.quoteEditorSelection", "editorTextFocus && editorHasSelection"],
		]);
		assert.equal(declared.get("ompDesk.quoteEditorSelection")?.title, "Quote Selection to Session");
		const editorEntries = menus.filter(({ menu, entry }) => menu === "editor/context" && entry.command === "ompDesk.quoteEditorSelection");
		assert.deepEqual(editorEntries.map(({ entry }) => entry.when), ["editorHasSelection"]);
		assert.equal(declared.get("ompDesk.quoteChatSelection")?.title, "Quote Selection");
		const entries = menus.filter(({ menu, entry }) => menu === "webview/context" && entry.command === "ompDesk.quoteChatSelection");
		assert.equal(entries.length, 1);
		assert.match(entries[0]?.entry.when ?? "", new RegExp(`webviewId =~ /\\^omp\\[\\.\\]session/ && ${CHAT_TEXT_MENU_KEY}$`));
		assert.equal(JSON.parse(CHAT_TEXT_MENU_CONTEXT)[CHAT_TEXT_MENU_KEY], true);
		const source = readFileSync(new URL("../extension.ts", import.meta.url), "utf8");
		assert.match(source, /registerDeskCommand\("ompDesk\.quoteEditorSelection", \(\) => quoteEditorSelectionToSession\(context, index\)\)/);
		assert.match(source, /registerDeskCommand\("ompDesk\.quoteChatSelection", \(\) => postChatPanelAction\("quote-selection"\)\)/, "a palette run with no argument posts the action and reads nothing");
	});

	it("bind Ctrl+O to expand/collapse all tool calls and Ctrl+Shift+O to the tool groups inside a Chat only, with a title and a Chat-only menu entry each", () => {
		const chatOnly = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
		const bound = (key: string) => contributes.keybindings.filter(binding => binding.key === key);
		assert.deepEqual(bound("ctrl+o").map(binding => binding.command), ["ompDesk.toggleToolOutput"]);
		assert.deepEqual(bound("ctrl+shift+o").map(binding => binding.command), ["ompDesk.toggleToolGroups"]);
		assert.equal(bound("ctrl+o")[0]?.when, chatOnly);
		assert.equal(bound("ctrl+shift+o")[0]?.when, chatOnly);
		assert.equal(declared.get("ompDesk.toggleToolGroups")?.title, "Expand/Collapse Tool Groups");
		for (const command of ["ompDesk.toggleToolOutput", "ompDesk.toggleToolGroups"]) {
			const entries = menus.filter(({ entry }) => entry.command === command);
			assert.ok(entries.length > 0 && entries.every(({ entry }) => entry.when === chatOnly), `${command} appears only in menus that require a Chat`);
		}
	});

	it("bind Ctrl+Alt+N to New Session and Ctrl+Alt+R to Resume Session from anywhere, and list both commands in the terminal's commandsToSkipShell", () => {
		const bound = (key: string) => contributes.keybindings.filter(binding => binding.key === key);
		assert.deepEqual(bound("ctrl+alt+n").map(binding => [binding.command, binding.when]), [["ompDesk.newSession", undefined]], "no when clause: the chord works in an editor, a Chat, the Sessions view and the terminal");
		assert.deepEqual(bound("ctrl+alt+r").map(binding => [binding.command, binding.when]), [["ompDesk.resumeWorkspaceFolder", undefined]]);
		const skipShell = contributes.configurationDefaults["terminal.integrated.commandsToSkipShell"] ?? [];
		for (const command of ["ompDesk.newSession", "ompDesk.resumeWorkspaceFolder"]) assert.ok(skipShell.includes(command), `${command} is in commandsToSkipShell, like the other workbench keys`);
		// The rows these chords stand for run the same commands.
		assert.equal(declared.get("ompDesk.newSession")?.title, "New Session");
		assert.equal(declared.get("ompDesk.resumeWorkspaceFolder")?.title, "Resume Session");
	});

	it("declare Fork Session, Branch… and Clear Context…, register each, offer them on live Sessions rows in Chat or with no editor, and in the Chat title menu except Branch, never hidden from the palette", () => {
		const titles: [string, string][] = [["ompDesk.forkSession", "Fork Session"], ["ompDesk.branchSession", "Branch…"], ["ompDesk.clearSession", "Clear Context…"]];
		const source = readFileSync(new URL("../extension.ts", import.meta.url), "utf8");
		for (const [command, title] of titles) {
			assert.equal(declared.get(command)?.title, title, `${command} title`);
			assert.equal(declared.get(command)?.category, "OMP Desk", `${command} category`);
			assert.ok(source.includes(`registerDeskCommand("${command}", `), `${command} is registered in extension.ts`);
			assert.ok(!hiddenFromPalette.has(command), `${command} is not hidden from the palette`);
		}
		const rows = (command: string) => menus.filter(({ menu, entry }) => menu === "view/item/context" && entry.command === command).map(({ entry }) => entry);
		const groups: [string, string][] = [["ompDesk.forkSession", "2_conversation@1"], ["ompDesk.branchSession", "2_conversation@2"], ["ompDesk.clearSession", "2_conversation@3"]];
		for (const [command, group] of groups) {
			const entries = rows(command);
			assert.equal(entries.length, 1, `${command} has one Sessions row entry`);
			assert.equal(entries[0]?.group, group, `${command} row group`);
			assert.ok((entries[0]?.when ?? "").startsWith("view == ompDesk.sessions"), `${command} row entry is limited to the Sessions view`);
			assert.ok((entries[0]?.when ?? "").includes("view-(none|chat)"), `${command} row entry needs a row shown in Chat or with no editor`);
		}
		assert.ok((rows("ompDesk.forkSession")[0]?.when ?? "").includes("materialized\\.view-(none|chat)"), "Fork needs a saved session file");
		assert.ok((rows("ompDesk.branchSession")[0]?.when ?? "").includes("materialized\\.view-(none|chat)"), "Branch needs a saved session file");
		assert.ok(!(rows("ompDesk.clearSession")[0]?.when ?? "").includes("materialized"), "Clear works on a fileless draft too");
		const chatOnly = "activeWebviewPanelId =~ /^omp[.]session/ && ompDesk.sessionMode == chat";
		const titleMenu = menus.filter(({ menu }) => menu === "editor/title").map(({ entry }) => entry);
		const inTitle = (command: string) => titleMenu.filter(entry => entry.command === command);
		assert.deepEqual(inTitle("ompDesk.forkSession").map(entry => [entry.group, entry.when]), [["2_rewind@2", chatOnly]]);
		assert.deepEqual(inTitle("ompDesk.clearSession").map(entry => [entry.group, entry.when]), [["3_session@5", chatOnly]]);
		assert.deepEqual(inTitle("ompDesk.branchSession"), [], "Branch is not in the Chat title menu: Rewind there opens the same picker");
	});
});

describe("views", () => {
	it("named by a when clause or a welcome entry are contributed, in a contributed container, and served by a provider", () => {
		const unknown: string[] = [];
		for (const { menu, entry } of menus) {
			for (const used of (entry.when ?? "").matchAll(/(?:^|[\s&|(!])view\s*==\s*([\w.]+)/g)) {
				if (!viewIds.has(used[1] ?? "")) unknown.push(`${used[1]} in ${where(menu, entry)}`);
			}
		}
		for (const welcome of contributes.viewsWelcome) if (!viewIds.has(welcome.view)) unknown.push(`${welcome.view} in a viewsWelcome entry`);
		assert.deepEqual(unknown, [], "names a view that is not contributed");

		const containers = new Set(Object.values(contributes.viewsContainers).flat().map(container => container.id));
		assert.deepEqual(Object.keys(contributes.views).filter(container => !containers.has(container)), [], "views placed in a container that is not contributed");

		const served = new Set([...recording.treeViews, ...recording.webviewViews]);
		assert.deepEqual([...viewIds].filter(id => !served.has(id)), [], "contributed but given no provider at runtime (the view would stay empty)");
		assert.deepEqual([...served].filter(id => !viewIds.has(id)), [], "given a provider at runtime but not contributed");
		const kindMismatch = views.filter(view => (view.type === "webview" ? recording.treeViews : recording.webviewViews).includes(view.id)).map(view => view.id);
		assert.deepEqual(kindMismatch, [], "contributed as one view type and served as the other");
	});

	it("are only tested against settings the extension contributes", () => {
		const settings = new Set(Object.keys(contributes.configuration.properties));
		const unknown: string[] = [];
		const clauses = [...menus.map(({ menu, entry }) => ({ by: where(menu, entry), when: entry.when ?? "" })), ...contributes.viewsWelcome.map(welcome => ({ by: `viewsWelcome of ${welcome.view}`, when: welcome.when ?? "" })),
			...contributes.keybindings.map(binding => ({ by: `keybinding ${binding.command}`, when: binding.when ?? "" }))];
		for (const { by, when } of clauses) {
			for (const used of when.matchAll(/\bconfig\.(ompDesk\.[\w.]+)/g)) if (!settings.has(used[1] ?? "")) unknown.push(`${used[1]} in ${by}`);
		}
		assert.deepEqual(unknown, [], "tests a setting that is not contributed (the clause is never true)");
	});
});

describe("context menus", () => {
	it("match rows their tree produces, and no row the tree produces is left without a menu", async () => {
		const produced = await producedByView();
		const dead: string[] = [];
		const matchedValues = new Map<string, Set<string>>();
		for (const { menu, entry } of menus.filter(candidate => candidate.menu === "view/item/context")) {
			const owner = where(menu, entry);
			const { view, matches } = viewItemTest(entry.when ?? "", owner);
			if (view === null) { dead.push(`${owner}: no view condition`); continue; }
			if (matches === null) continue;
			const rows = produced.get(view);
			if (rows === undefined) { dead.push(`${owner}: no tree of this extension serves ${view}`); continue; }
			const hits = [...new Set(rows.flatMap(row => (row.contextValue !== undefined && matches(row.contextValue) ? [row.contextValue] : [])))];
			if (hits.length === 0) dead.push(`${owner}: no row of ${view} has a matching contextValue`);
			for (const hit of hits) (matchedValues.get(view) ?? matchedValues.set(view, new Set()).get(view)!).add(hit);
		}
		assert.deepEqual(dead, [], "a menu entry no row can satisfy: it is never shown");

		const orphaned: string[] = [];
		for (const [view, rows] of produced) {
			for (const value of new Set(rows.flatMap(row => (row.contextValue === undefined ? [] : [row.contextValue])))) {
				if (!matchedValues.get(view)?.has(value) && !CLICK_ONLY_ROWS.has(value)) orphaned.push(`${view}: ${value}`);
			}
		}
		assert.deepEqual(orphaned, [], "a row the tree produces that no view/item/context entry matches");
	});
});

describe("the palette", () => {
	/** Invoke every palette-visible command's registered handler the way the palette does: no argument. Dialogs answer "dismissed". */
	let palettePass: Promise<{ failures: string[]; executed: string[] }> | undefined;
	function runPalette(): Promise<{ failures: string[]; executed: string[] }> {
		palettePass ??= (async () => {
			const failures: string[] = [];
			const visible = [...declared.keys()].filter(id => !hiddenFromPalette.has(id));
			const before = recording.executed.length;
			for (const id of visible) {
				try {
					await recording.commands.get(id)?.();
				} catch (error) {
					failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return { failures, executed: recording.executed.slice(before).map(call => String(call[0])) };
		})();
		return palettePass;
	}

	it("hides only what needs a row or an editor, and everything it hides is reachable another way", async () => {
		const { executed } = await runPalette();
		const rowCommands = new Set([...(await producedByView()).values()].flat().flatMap(row => (row.command === undefined ? [] : [row.command])));
		const reachable = new Set<string>([
			...menus.filter(candidate => candidate.menu !== "commandPalette").flatMap(({ entry }) => (entry.command === undefined ? [] : [entry.command])),
			...contributes.keybindings.map(binding => binding.command),
			...contributes.viewsWelcome.flatMap(welcome => [...welcome.contents.matchAll(/\(command:([\w.]+)\)/g)].map(link => link[1] ?? "")),
			...rowCommands,
			...executed,
		]);
		assert.deepEqual([...hiddenFromPalette].filter(id => !declared.has(id)), [], "hidden from the palette but not declared");
		assert.deepEqual([...hiddenFromPalette].filter(id => !reachable.has(id)), [], "hidden from the palette and reachable from no menu, keybinding, welcome link, row or command: nothing can run it");
		assert.deepEqual(palette.filter(entry => entry.when !== "false").map(entry => entry.command), [], "a palette entry whose condition is not simply false: its commands need a case of their own");
	});

	it("runs every visible command without an argument and without throwing", { timeout: 120_000 }, async () => {
		const { failures } = await runPalette();
		assert.deepEqual(failures, [], "a command the palette offers threw when run with no argument");
	});

	it("tells why an editor does not open when the configured OMP cannot be used, and does not reject", async () => {
		for (const id of ["ompDesk.openOmpSettings", "ompDesk.openModels", "ompDesk.openAgents"]) {
			const before = recording.prompts.length;
			await recording.commands.get(id)?.();
			const shown = recording.prompts.slice(before).filter(prompt => prompt.kind === "showErrorMessage").map(prompt => String(prompt.args[0]));
			assert.equal(shown.length, 1, `${id} shows one error`);
			assert.match(shown[0]!, /The OMP named by the ompDesk\.executablePath setting \(.*no-such-omp\.exe\) cannot be used/, `${id} says why`);
		}
	});

	it("only executes commands that exist when a visible command runs another", async () => {
		const { executed } = await runPalette();
				const viewFocus = new Set([...viewIds].map(id => `${id}.focus`));
		const missing = [...new Set(executed)].filter(id => id.startsWith("ompDesk.") && !viewFocus.has(id) && !recording.commands.has(id));
		assert.deepEqual(missing, [], "executed by a command of this extension but registered by no one");
	});
});

describe("the namespace (ADR-0068)", () => {
	/** The only `omp.` names the manifest may still hold, each with the reason; a new entry needs a decision, not a rename. */
	const OMP_NAMESPACE_EXCEPTIONS = new Map<string, string>([
		["omp.session", "webview view type (activation event); persisted editor identity, not a contributed id"],
		["omp.shellTerminal", "webview view type (activation event)"],
		["omp.settings", "webview view type (activation event)"],
		["omp.exe", "the program name inside a description"],
		["omp.sh", "the name of OMP's binary install script inside a description"],
		["omp.focusComposer", "commandsToSkipShell for the legacy alias of ompDesk.focusComposer"],
		["omp.goToSession", "commandsToSkipShell for the legacy alias of ompDesk.goToSession"],
		["omp.moveFileToNewWindow", "commandsToSkipShell for the legacy alias of ompDesk.moveFileToNewWindow"],
		["omp.newSession", "commandsToSkipShell for the legacy alias of ompDesk.newSession"],
		["omp.resumeWorkspaceFolder", "commandsToSkipShell for the legacy alias of ompDesk.resumeWorkspaceFolder"],
		...LEGACY_SETTING_NAMES.map((name): [string, string] => [`omp.${name}`, "hidden deprecated setting of 0.3.x, kept so VS Code still reads, routes and syncs the old value until the migration moved it"]),
	]);

	it("gives every command the category OMP Desk and an id under ompDesk.", () => {
		const wrong = contributes.commands.filter(command => (command as { category?: string }).category !== "OMP Desk" || !command.command.startsWith("ompDesk.")).map(command => command.command);
		assert.deepEqual(wrong, [], "a command outside the OMP Desk category or the ompDesk. namespace");
	});

	it("contributes every command, container, view, keybinding and context key under ompDesk., apart from the listed exceptions", () => {
		const containerIds = Object.values(contributes.viewsContainers).flat().map(container => container.id);
		const outside = [...containerIds, ...Object.keys(contributes.views), ...views.map(view => view.id)].filter(id => !id.startsWith("ompDesk"));
		assert.deepEqual(outside, [], "a contributed id outside the ompDesk namespace");
		const tokens = new Set(JSON.stringify(manifest).match(/\bomp\.[A-Za-z][\w.]*/g) ?? []);
		const unexplained = [...tokens].filter(token => !OMP_NAMESPACE_EXCEPTIONS.has(token));
		assert.deepEqual(unexplained, [], "the manifest names something in the omp. namespace that no exception explains");
	});

	it("holds each setting of 0.3.x under ompDesk., and under omp. only as a hidden, deprecated key of the same scope", () => {
		const properties = contributes.configuration.properties as Record<string, { scope?: string; included?: boolean; deprecationMessage?: string }>;
		const current = Object.keys(properties).filter(key => key.startsWith("ompDesk."));
		const old = Object.keys(properties).filter(key => key.startsWith("omp."));
		assert.deepEqual(Object.keys(properties).filter(key => !key.startsWith("ompDesk.") && !key.startsWith("omp.")), [], "a setting outside both namespaces");
		assert.deepEqual(old.map(key => key.slice("omp.".length)).sort(), [...LEGACY_SETTING_NAMES].sort());
		for (const key of old) {
			const successor = `ompDesk.${key.slice("omp.".length)}`;
			assert.ok(current.includes(successor), `${key} has no successor`);
			assert.equal(properties[key]?.included, false, `${key} must stay out of the Settings editor`);
			assert.ok((properties[key]?.deprecationMessage ?? "").includes(successor), `${key} must name ${successor}`);
			assert.equal(properties[key]?.scope, properties[successor]?.scope, `${key} keeps the scope VS Code routes it by`);
		}
	});

	it("keeps the omp. skip-shell entries exactly for the aliases of the ompDesk. ones", () => {
		const defaults = contributes.configurationDefaults["terminal.integrated.commandsToSkipShell"] ?? [];
		const current = defaults.filter(id => id.startsWith("ompDesk."));
		const legacy = defaults.filter(id => id.startsWith("omp."));
		assert.deepEqual(legacy, current.map(id => "omp." + id.slice("ompDesk.".length)));
		assert.ok(legacy.every(id => LEGACY_COMMAND_IDS.includes(id)));
	});

	it("keeps one alias for each of the 92 commands that existed before the rename (0.3.1's 87 plus five added on the way to 0.4.0), none of them contributed, each aimed at a contributed command", () => {
		assert.equal(LEGACY_COMMAND_IDS.length, 92);
		assert.equal(new Set(LEGACY_COMMAND_IDS).size, 92);
		assert.deepEqual(LEGACY_COMMAND_IDS.filter(id => declared.has(id)), [], "an alias that is also a contributed command");
		assert.deepEqual(LEGACY_COMMAND_IDS.map(legacyCommandTarget).filter(id => !declared.has(id)), [], "an alias whose target is not contributed");
		const addedAfterRename = contributes.commands.map(command => command.command).filter(id => !LEGACY_COMMAND_IDS.includes("omp." + id.slice("ompDesk.".length)));
		assert.deepEqual(addedAfterRename.sort(), ["ompDesk.branchSession", "ompDesk.clearSession", "ompDesk.findInChat", "ompDesk.forkSession", "ompDesk.logoutProvider", "ompDesk.openOmpSettings", "ompDesk.quoteChatSelection", "ompDesk.quoteEditorSelection", "ompDesk.refreshUsageStatus", "ompDesk.reloadAllWindows", "ompDesk.searchFileFromChat", "ompDesk.toggleToolGroups"], "the commands added after the rename have no alias; a new command needs none");
		assert.deepEqual(LEGACY_ALIASES.map(([oldId]) => oldId).filter(id => !recording.commands.has(id)), [], "an old id with no alias at runtime");
		const generated = LEGACY_ALIASES.filter(([, target]) => !declared.has(target)).map(([oldId, target]) => `${oldId} -> ${target}`);
		assert.deepEqual(generated, [
			"workbench.view.extension.omp -> workbench.view.extension.ompDesk",
			...["sessions", "skills", "tools", "mcp", "extensions", "context", "deskSettings"].map(name => `omp.${name}.focus -> ompDesk.${name}.focus`),
		], "the commands VS Code generates for the container and the views");
		for (const [, target] of LEGACY_ALIASES.filter(([oldId]) => oldId.endsWith(".focus"))) assert.ok(viewIds.has(target.slice(0, -".focus".length)), `${target} is not a contributed view's focus command`);
	});

	it("runs the new command once, with the arguments, and warns once per old id", async () => {
		const warnings = () => recording.prompts.filter(prompt => prompt.kind === "showWarningMessage" && String(prompt.args[0]).includes("omp.openSession"));
		const before = recording.executed.length;
		const argument = { tabId: "tab:x" };
		await recording.commands.get("omp.openSession")?.(argument);
		await recording.commands.get("omp.openSession")?.(argument);
		const forwarded = recording.executed.slice(before).filter(call => call[0] === "ompDesk.openSession");
		assert.deepEqual(forwarded, [["ompDesk.openSession", argument], ["ompDesk.openSession", argument]]);
		assert.equal(warnings().length, 1, "one warning for this old id, however often it runs");
		assert.match(String(warnings()[0]?.args[0]), /omp\.openSession.*ompDesk\.openSession/);
	});

	it("declares the keys of every view's welcome content and menu in the one namespace, and sets each context key a when clause tests", () => {
		const clauses = [...menus.map(({ entry }) => entry.when ?? ""), ...contributes.viewsWelcome.map(welcome => welcome.when ?? ""), ...contributes.keybindings.map(binding => binding.when ?? "")];
		const configured = new Set(Object.keys(contributes.configuration.properties));
		const tested = new Set(clauses.flatMap(clause => [...clause.matchAll(/(?<![\w.])(ompDesk\.[\w.]+)/g)].map(match => match[1] ?? "")));
		const sources = ["../extension.ts", "./context-wiring.ts", "./inventory-wiring.ts", "./process-wiring.ts"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
		const unset = [...tested].filter(key => !configured.has(key.replace(/^config\./, "")) && !viewIds.has(key) && !recording.contextKeys.has(key) && !sources.includes(`"${key}"`) && !/^ompDesk\.(skills|tools|mcp|extensions)\.scope$/.test(key));
		assert.deepEqual(unset, [], "a when clause tests a context key nothing in the source sets (the clause is never true)");
	});

	it("publishes the context keys default keybindings tested under their old names too", () => {
		assert.deepEqual([...LEGACY_CONTEXT_KEYS], ["sessionMode", "streaming", "composerPopupOpen"]);
	});
});
