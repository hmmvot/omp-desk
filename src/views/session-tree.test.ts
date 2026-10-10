/**
 * Behavioral tests for the launcher tree.
 *
 * What is worth defending here is what the launcher is *allowed to claim*: it
 * roots a tree at the folders the user added, in their order; it shows one row per
 * indexed conversation whose recorded working directory is exactly that folder —
 * **whether or not an editor is open**, and including stopped conversations; it
 * never invents a folder and never merges two folders' sessions. A row's label is
 * OMP's own stored title, then the last observed one, then a stable
 * `New session N`, and never the folder name. The icon encodes agent state by a
 * fixed precedence in which a stopped row can never look busy and a pending
 * question is never hidden behind Working.
 *
 * The provider runs against a stand-in `vscode` module (`vscode-test-stub.ts`),
 * so no editor process is involved and every assertion is about this extension's
 * projection rather than about VS Code's own behaviour. The provider imports the
 * editor API, so this file must run under `node --test` (the module hooks below
 * are Node's); `bun test` cannot resolve the `vscode` specifier.
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
import type { LauncherFolder } from "./launcher-folders.ts";
import type {
	SessionActivityFacts,
	SessionItemState,
	SessionLauncherFacts,
	SessionTreeItem,
	SessionLauncherSource,
	SessionTreeProvider,
	WorkspaceFolderTreeItem,
} from "./session-tree.ts";

// The provider imports the editor API, so the `vscode` specifier is mapped before
// it is loaded, and its own extensionless imports are given the extension Node
// needs. Both hooks must exist before the first import of the provider, which is
// why the imports below are dynamic: a static import is evaluated first.
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

const { TreeItemCollapsibleState } = await import("./vscode-test-stub.ts");
const sessionTree = await import("./session-tree.ts");
const { WorkspaceFolderRegistry } = await import("./workspace-folders.ts");
// Register the extensionless dependency hook above before loading the index.
const { SessionIndex } = await import("../host/session-index.ts");

// Absolute on every platform, and deliberately not required to exist: the
// registry's directory check is injected in these tests, and the folder match
// compares paths rather than reading the disk.
const ALPHA = path.join(os.tmpdir(), "omp-launcher-tree", "alpha");
const BETA = path.join(os.tmpdir(), "omp-launcher-tree", "beta");
const UNREGISTERED = path.join(os.tmpdir(), "omp-launcher-tree", "gamma");

const NO_FACTS: SessionLauncherFacts = { open: false, running: false, outcome: null, activity: null };

type FolderRow = InstanceType<typeof WorkspaceFolderTreeItem>;
type SessionRow = InstanceType<typeof SessionTreeItem>;
type Provider = InstanceType<typeof SessionTreeProvider>;
type Registry = InstanceType<typeof WorkspaceFolderRegistry>;

const providers = new Set<Provider>();
function providerFor(source: Omit<SessionLauncherSource, "observeOwnership" | "runtimeIdentity"> &
	Partial<Pick<SessionLauncherSource, "observeOwnership" | "runtimeIdentity">>,
	options: ConstructorParameters<typeof sessionTree.SessionTreeProvider>[1] = {}): Provider {
	const provider = new sessionTree.SessionTreeProvider({
		...source,
		runtimeIdentity: source.runtimeIdentity ?? (() => null),
		observeOwnership: source.observeOwnership ?? (async () => ({ ownershipChecked: true })),
	}, options);
	providers.add(provider);
	return provider;
}

function waitForRows(provider: Provider, predicate: () => boolean): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise(resolve => {
		const subscription = provider.onDidChangeTreeData(() => {
			if (!predicate()) return;
			subscription.dispose();
			resolve();
		});
	});
}

function folder(id: string, folderPath: string, collapsed = false, flags: { readonly pinned?: boolean; readonly open?: boolean } = {}): LauncherFolder {
	return { id, path: folderPath, collapsed, pinned: flags.pinned ?? true, open: flags.open ?? false };
}

/** The pinned registry's folders as the merged list the launcher shows. */
function pinnedFolders(registry: Registry): LauncherFolder[] {
	return registry.list().map(registered => ({ ...registered, pinned: true, open: false }));
}

/** The codicon id of an item's icon, narrowed rather than assumed. */
function iconId(item: { readonly iconPath?: unknown }): string | undefined {
	const icon = item.iconPath;
	return typeof icon === "object" && icon !== null && "id" in icon ? String(icon.id) : undefined;
}

/** Plain tooltip text. */
function tooltipText(item: { readonly tooltip?: unknown }): string {
	assert.equal(typeof item.tooltip, "string");
	return item.tooltip as string;
}

function entry(overrides: Partial<SessionIndexEntry> & { readonly tabId: string; readonly cwd: string }): SessionIndexEntry {
	return {
		kind: "draft",
		origin: "extension",
		sessionFile: null,
		sessionId: null,
		scope: { profile: null, sessionDir: null },
		sessionDir: null,
		ownership: null,
		host: null,
		createdAt: "2026-09-25T10:00:00.000Z",
		lastActiveAt: "2026-09-25T10:05:00.000Z",
		ordinal: 0,
		availability: "draft",
		detail: null,
		runIntent: "stopped",
		title: null,
		lastCompletedReplyId: null,
		lastSeenReplyId: null,
		...overrides,
	};
}

/** Activity of an attached guest: idle unless a field says otherwise. */
function activity(overrides: Partial<SessionActivityFacts> = {}): SessionActivityFacts {
	return {
		pendingQuestion: false,
		working: false,
		backgroundWork: false,
		settled: true,
		trailingQuestion: false,
		lastCompletedReplyId: null,
		lastSeenReplyId: null,
		...overrides,
	};
}

/** A registry backed by an in-memory memento, whose directory check accepts exactly the listed paths. */
function stubRegistry(accepted: readonly string[]): Registry {
	const values = new Map<string, unknown>();
	const store: WorkspaceFolderStore = {
		get<T>(key: string): T | undefined {
			return values.get(key) as T | undefined;
		},
		update(key: string, value: unknown): unknown {
			values.set(key, value);
			return undefined;
		},
	};
	const inspector: FolderPathInspector = {
		async inspect(rawPath: string) {
			return accepted.includes(rawPath)
				? ({ ok: true, path: rawPath } as const)
				: ({ ok: false, reason: `${rawPath} is not a directory.` } as const);
		},
	};
	return new WorkspaceFolderRegistry({ store, inspector });
}

/** Add one folder through the registry and return its id, as the extension's Add flow does. */
async function addedFolderId(registry: Registry, folderPath: string): Promise<string> {
	const added = await registry.add(folderPath);
	if (!added.ok) throw new Error(`${folderPath} was not added: ${added.reason}`);
	return added.folder.id;
}

async function rootsOf(provider: Provider): Promise<FolderRow[]> {
	return (await provider.getChildren()) as FolderRow[];
}

async function rowsOf(provider: Provider, folderRow: FolderRow): Promise<SessionRow[]> {
	return (await provider.getChildren(folderRow)) as SessionRow[];
}

/** The contributions this extension actually ships, read exactly as the editor reads them. */
const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	readonly contributes: {
		readonly menus: {
			readonly "view/item/context"?: ReadonlyArray<{ readonly command: string; readonly when: string }>;
			readonly commandPalette?: ReadonlyArray<{ readonly command: string; readonly when: string }>;
		};
	};
};

/**
 * Every `view/item/context` contribution whose `when` clause matches one row context
 * value, in contribution order and with duplicates kept.
 *
 * The clause is the pair VS Code evaluates — the view id and a regex over the item's
 * `contextValue` — so the tokens `session-tree.ts` builds and the clauses in
 * `package.json` are asserted together instead of drifting apart.
 */
function contributedCommands(contextValue: string): string[] {
	const clauses = (packageJson.contributes.menus["view/item/context"] ?? []).filter(item =>
		item.when.startsWith("view == omp.sessions && viewItem =~ /"),
	);
	return clauses
		.filter(item => new RegExp(item.when.slice(item.when.indexOf("/") + 1, item.when.lastIndexOf("/"))).test(contextValue))
		.map(item => item.command);
}

describe("folder path descriptions", () => {
	it("keeps paths at the budget verbatim and truncates only above it", () => {
		for (const length of [1, 39, 40]) {
			const cwd = `/${"a".repeat(length - 1)}`;
			assert.equal(sessionTree.folderPathDescription(cwd), cwd);
		}
		const cwd = `/${"a".repeat(40)}`;
		assert.equal(sessionTree.folderPathDescription(cwd), `${cwd.slice(0, 8)}…${cwd.slice(-31)}`);
	});
	it("preserves the drive/root start and useful final segments", () => {
		for (const cwd of [
			"D:\\Workfiles\\a-very-long-intermediate-directory\\project\\src",
			"/home/developer/a-very-long-intermediate-directory/project/src",
			"\\\\server\\share\\a-very-long-intermediate-directory\\project\\src",
		]) {
			const description = sessionTree.folderPathDescription(cwd);
			assert.equal(description.length, 40);
			assert.ok(description.startsWith(cwd.slice(0, 8)));
			assert.ok(description.includes("…"));
			assert.ok(description.endsWith(cwd.slice(-20)));
			const row = new sessionTree.WorkspaceFolderTreeItem(folder("folder:test", cwd), []);
			assert.equal(row.description, description);
			assert.equal(JSON.parse(row.diagnostics).folder.path, cwd);
			assert.ok(row.accessibilityInformation?.label.includes(cwd));
			assert.ok(tooltipText(row).split("\n").length <= 4);
			assert.doesNotMatch(tooltipText(row), /Group node|writer|claim|broker/);
		}
	});
});

/**
 * The context menu of a session row is `package.json` `when` clauses evaluated over the
 * `contextValue` this tree builds, so one table defends both halves at once: a state that
 * gains or loses an action in either file fails here. Live rows never say "Open" (the process
 * already runs), stopped rows never offer lifecycle actions on a process that does not exist,
 * and transitional rows offer nothing that would race their own transition.
 */
describe("session row menu per state", () => {
	const FILE = path.join(os.tmpdir(), "omp-launcher-tree", "menu.jsonl");
	const LIVE = ["running", "working", "background", "question", "unread", "waiting"] as const;
	const OPEN = ["omp.openSessionInChat", "omp.openSessionInTerminal"];
	const SHOW_BOTH = ["omp.showSessionInChat", "omp.showSessionInTerminal"];
	const LIVE_REST = ["omp.renameSession", "omp.reloadSession", "omp.closeSession", "omp.deleteSession"];
	const attached = (viewMode: "chat" | "terminal" | null): SessionLauncherFacts =>
		({ ...NO_FACTS, open: viewMode !== null, running: true, viewMode });
	const materialized = entry({ tabId: "tab:menu", cwd: ALPHA, kind: "session", sessionFile: FILE, availability: "live", runIntent: "running" });
	const fileless = entry({ tabId: "tab:menu", cwd: ALPHA });
	const cases: ReadonlyArray<{
		readonly name: string;
		readonly state: SessionItemState;
		readonly entry: SessionIndexEntry;
		readonly facts: SessionLauncherFacts;
		readonly expected: readonly string[];
	}> = [
		{ name: "stopped", state: "stopped", entry: materialized, facts: NO_FACTS,
			expected: ["omp.openSession", ...OPEN, "omp.renameSession", "omp.forgetSession", "omp.deleteSession"] },
		{ name: "draft", state: "draft", entry: fileless, facts: NO_FACTS,
			expected: ["omp.openSession", ...OPEN, "omp.renameSession", "omp.forgetSession"] },
		...LIVE.flatMap(state => [
			{ name: `${state} shown in Chat`, state, entry: materialized, facts: attached("chat"),
				expected: ["omp.showSessionInTerminal", ...LIVE_REST] },
			{ name: `${state} shown in Terminal`, state, entry: materialized, facts: attached("terminal"),
				expected: ["omp.showSessionInChat", ...LIVE_REST] },
			{ name: `${state} with its editor closed`, state, entry: materialized, facts: attached(null),
				expected: [...SHOW_BOTH, ...LIVE_REST] },
		]),
		{ name: "a fileless live draft has nothing to reload or delete", state: "working", entry: fileless, facts: attached("chat"),
			expected: ["omp.showSessionInTerminal", "omp.renameSession", "omp.closeSession"] },
		{ name: "a verified live writer this window has not attached", state: "running", entry: materialized,
			facts: { ...NO_FACTS, ownedWriterPid: 4242, ownershipChecked: true }, expected: [...SHOW_BOTH, ...LIVE_REST] },
		{ name: "open in another window", state: "otherWindow", entry: materialized,
			facts: { ...NO_FACTS, heldElsewhere: true, switchableWindow: true }, expected: ["omp.stopSessionHost", "omp.switchToSessionWindow"] },
		{ name: "another window without a saved navigation identity", state: "otherWindow", entry: materialized,
			facts: { ...NO_FACTS, heldElsewhere: true, switchableWindow: false }, expected: ["omp.stopSessionHost"] },
		{ name: "open in another OMP process", state: "externalOmp", entry: materialized,
			facts: { ...NO_FACTS, externalOmp: true, ownershipChecked: true }, expected: OPEN },
		{ name: "blocked by a missing transcript", state: "blocked",
			entry: entry({ tabId: "tab:menu", cwd: ALPHA, kind: "session", sessionFile: FILE, availability: "failed" }),
			facts: NO_FACTS, expected: ["omp.forgetSession"] },
		{ name: "restoring", state: "restoring", entry: materialized, facts: { ...NO_FACTS, restoring: true }, expected: [] },
		{ name: "starting", state: "starting", entry: materialized, facts: { ...NO_FACTS, launching: true }, expected: [] },
		{ name: "stopping", state: "stopping", entry: materialized, facts: { ...attached("chat"), stopping: true }, expected: [] },
		{ name: "checking", state: "checking", entry: materialized, facts: { ...NO_FACTS, checking: true }, expected: [] },
	];

	for (const row of cases) {
		it(`offers exactly the actions that fit: ${row.name}`, () => {
			const item = new sessionTree.SessionTreeItem(row.entry, row.state, { header: null, conversation: { lastAt: "1970-01-01T00:00:00.000Z" }, facts: row.facts, active: false, now: 0 });
			assert.deepEqual([...contributedCommands(item.contextValue!)].sort(), ["omp.copyRowDiagnostics", ...row.expected].sort(), item.contextValue);
			assert.ok(tooltipText(item).split("\n").length <= 4);
			assert.doesNotMatch(tooltipText(item), /writer|claim|broker|Run intent|Tab order/);
			assert.equal(JSON.parse(item.diagnostics).entry.tabId, row.entry.tabId);
		});
	}

	it("covers every row state, and never offers Open on a live row or Show on a stopped one", () => {
		const covered: Record<SessionItemState, boolean> = {
			otherWindow: false, externalOmp: false, blocked: false, restoring: false, starting: false, stopping: false, checking: false, stopped: false,
			draft: false, question: false, working: false, background: false, unread: false, waiting: false, running: false,
		};
		for (const row of cases) covered[row.state] = true;
		assert.deepEqual(Object.entries(covered).filter(([, seen]) => !seen), []);
		for (const row of cases) {
			const live = (LIVE as readonly string[]).includes(row.state);
			for (const command of row.expected) {
				if (live) assert.equal(OPEN.includes(command), false, `${row.name}: ${command}`);
				if (row.state === "stopped" || row.state === "draft") assert.equal(SHOW_BOTH.includes(command), false, `${row.name}: ${command}`);
			}
		}
	});

	it("keeps Show in Chat and Show in Terminal out of the palette: they only make sense from a tree row", () => {
		const palette = packageJson.contributes.menus.commandPalette ?? [];
		for (const command of SHOW_BOTH) assert.ok(palette.some(item => item.command === command && item.when === "false"), command);
	});
});

describe("session naming priority", () => {
	it("uses OMP names and explicit cached renames before a first-prompt summary", () => {
		const unnamed = entry({ tabId: "tab:prompt", cwd: ALPHA, title: null });
		const header = { sessionId: "s", cwd: ALPHA, title: null, promptTitle: "Fix the login layout" };
		assert.equal(sessionTree.sessionHeadline(unnamed, header), header.promptTitle);
		assert.equal(sessionTree.sessionHeadline({ ...unnamed, title: "My chosen name" }, header), "My chosen name");
		assert.equal(sessionTree.sessionHeadline({ ...unnamed, title: "My chosen name" }, { ...header, title: "OMP name" }), "OMP name");
	});
	it("shows an OMP 18.8 card title without its Nerd Font private-use icon, and never empties a title into the ordinal", () => {
		const unnamed = entry({ tabId: "tab:card", cwd: ALPHA, title: null });
		const header = { sessionId: "s", cwd: ALPHA, title: "\u{F0093} GREET: Suggest greet unit test name", promptTitle: "Suggest one unit test" };
		assert.equal(sessionTree.sessionHeadline(unnamed, header), "GREET: Suggest greet unit test name");
		assert.equal(sessionTree.sessionHeadline({ ...unnamed, title: "\uE0A0  BMP glyph" }, null), "BMP glyph");
		assert.equal(sessionTree.sessionHeadline(unnamed, { ...header, title: "\u{1F9EA} FLAKY: Fix flaky tests" }), "\u{1F9EA} FLAKY: Fix flaky tests", "emoji icons render and stay");
		assert.equal(sessionTree.sessionHeadline(unnamed, { ...header, title: "\u{F0093}" }), header.promptTitle, "an icon-only title falls through to the next source");
	});
});

describe("launcher tree", () => {
	let temp: string;
	let sessionFile: string;

	before(async () => {
		temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-launcher-tree-"));
		sessionFile = path.join(temp, "2026-09-25T10-00-00-000Z_session-1.jsonl");
		await fs.promises.writeFile(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "session-1", cwd: ALPHA, title: "OMP title wins" })}\n`,
			"utf8",
		);
	});

	after(async () => {
		for (const provider of providers) provider.dispose();
		await fs.promises.rm(temp, { recursive: true, force: true });
	});

	async function build(options: {
		readonly folders: readonly LauncherFolder[];
		readonly entries: readonly SessionIndexEntry[];
		readonly open?: ReadonlySet<string>;
		readonly running?: ReadonlySet<string>;
		readonly activities?: ReadonlyMap<string, SessionActivityFacts>;
		readonly outcomes?: ReadonlyMap<string, SessionLauncherFacts["outcome"]>;
		readonly restoring?: ReadonlySet<string>;
		readonly activeTabId?: string | null;
	}): Promise<{ readonly provider: Provider; readonly roots: readonly FolderRow[] }> {
		const open = options.open ?? new Set<string>();
		const running = options.running ?? new Set<string>();
		const provider = providerFor({
			folders: () => options.folders,
			entries: () => options.entries,
			activeTabId: () => options.activeTabId ?? null,
			facts: tabId => ({
				open: open.has(tabId),
				running: running.has(tabId),
				outcome: options.outcomes?.get(tabId) ?? null,
				restoring: options.restoring?.has(tabId) ?? false,
				activity: options.activities?.get(tabId) ?? null,
			}),
		});
		const roots = await rootsOf(provider);
		await waitForRows(provider, () => roots.every(root => root.rows.every(row => row.state !== "checking")));
		return { provider, roots };
	}

	it("roots the tree at the registered folders, in their order, and only those", async () => {
		const { roots } = await build({
			folders: [folder("folder:alpha", ALPHA), folder("folder:beta", BETA)],
			entries: [entry({ tabId: "tab:open", cwd: ALPHA })],
			open: new Set(["tab:open"]),
		});
		assert.deepEqual(
			roots.map(root => [root.id, root.label]),
			[
				["folder:alpha", "alpha"],
				["folder:beta", "beta"],
			],
		);
		// Every root is a folder: there is no group node, and therefore no always
		// visible history section.
		assert.ok(roots.every(root => root instanceof sessionTree.WorkspaceFolderTreeItem));
	});

	it("lists a conversation whether or not its editor is open, and never under an unregistered folder", async () => {
		const closed = entry({ tabId: "tab:closed", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" });
		const open = entry({ tabId: "tab:open", cwd: ALPHA });
		const elsewhere = entry({ tabId: "tab:elsewhere", cwd: UNREGISTERED, kind: "session", sessionFile });
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [closed, open, elsewhere],
			open: new Set(["tab:open", "tab:elsewhere"]),
		});
		const children = await rowsOf(provider, roots[0]!);
		// The closed row is listed (closing an editor does not erase a conversation).
		// Neither row is live, so the order falls back to the index ordinal.
		assert.deepEqual(
			children.map(row => row.tabId),
			["tab:closed", "tab:open"],
		);
		// A session of an unregistered folder is not rendered anywhere.
		assert.equal(await provider.itemFor("tab:elsewhere"), undefined);
		const row = await provider.itemFor("tab:closed");
		assert.equal(row, children[0]);
		assert.equal(provider.getParent(children[0]!), roots[0]);
		assert.equal(provider.getParent(roots[0]!), undefined);
	});

	it("matches a folder by exact working directory, not by prefix", async () => {
		const nested = entry({ tabId: "tab:nested", cwd: path.join(ALPHA, "nested") });
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [nested],
		});
		assert.deepEqual(roots[0]?.rows, []);
		assert.equal(provider.getChildren(roots[0]!)[0]?.command?.command, "omp.newSession");
	});

	it("keeps an empty folder visible, collapsible, and its collapse state across a rebuild", async () => {
		// Driven through the real registry, because the toggle the view reports is a
		// registry write — this is the path the extension's expand/collapse handlers use.
		const registry = stubRegistry([BETA, ALPHA]);
		const emptyFolderId = await addedFolderId(registry, BETA);
		const filledFolderId = await addedFolderId(registry, ALPHA);
		await registry.setCollapsed(filledFolderId, true);
		const provider = providerFor({
			folders: () => pinnedFolders(registry),
			entries: () => [entry({ tabId: "tab:collapsed", cwd: ALPHA })],
			activeTabId: () => null,
			facts: () => NO_FACTS,
		});
		const roots = await rootsOf(provider);
		// Every added folder offers the native expand/collapse affordance even when empty.
		assert.equal(roots[0]!.collapsibleState, TreeItemCollapsibleState.Expanded);
		const placeholder = provider.getChildren(roots[0]!)[0]!;
		assert.equal(placeholder.command?.command, "omp.newSession");
		assert.equal(placeholder.command?.arguments?.[0], roots[0]);
		assert.equal(provider.getParent(placeholder), roots[0]);
		// The saved collapse value is what the node is built from, so a rebuild does
		// not expand a folder the user collapsed.
		assert.equal(roots[1]!.collapsibleState, TreeItemCollapsibleState.Collapsed);
		provider.refresh();
		const rebuilt = await rootsOf(provider);
		assert.equal(rebuilt[1]!.collapsibleState, TreeItemCollapsibleState.Collapsed);
		// The preference can be set before the folder's first session appears.
		assert.equal(await registry.setCollapsed(emptyFolderId, true), true);
		provider.refresh();
		const toggled = await rootsOf(provider);
		assert.equal(toggled[0]!.collapsibleState, TreeItemCollapsibleState.Collapsed);
		assert.equal(provider.getChildren(toggled[0]!)[0]?.command?.command, "omp.newSession");
	});

	it("places the login action above folders only while the no-model flag is set", () => {
		const provider = providerFor({ folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [], activeTabId: () => null, facts: () => NO_FACTS });
		const original = provider.getChildren()[0]!;
		let changes = 0;
		provider.onDidChangeTreeData(() => { changes++; });
		provider.setProviderLoginRequired(true);
		const [login, retained] = provider.getChildren();
		assert.ok(login instanceof sessionTree.ProviderLoginTreeItem);
		assert.equal(login.label, "Log in to a model provider to start");
		assert.equal(login.command?.command, "omp.loginProvider");
		assert.equal(iconId(login), "account");
		assert.equal(login.collapsibleState, TreeItemCollapsibleState.None);
		assert.equal(provider.getParent(login), undefined);
		assert.deepEqual(provider.getChildren(login), []);
		assert.equal(retained, original);
		provider.setProviderLoginRequired(true);
		assert.equal(changes, 1, "unchanged cached availability does not repaint");
		provider.refresh();
		assert.equal(provider.getChildren()[0], login, "the action has stable identity");
		provider.setProviderLoginRequired(false);
		assert.deepEqual(provider.getChildren(), [original]);
	});

	it("keeps each folder's conversation membership separate", async () => {
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA), folder("folder:beta", BETA)],
			entries: [entry({ tabId: "tab:alpha", cwd: ALPHA, kind: "session", sessionFile }), entry({ tabId: "tab:beta", cwd: BETA })],
			activeTabId: "tab:beta",
		});
		const alpha = await rowsOf(provider, roots[0]!);
		const beta = await rowsOf(provider, roots[1]!);
		assert.deepEqual(
			alpha.map(row => row.tabId),
			["tab:alpha"],
		);
		assert.deepEqual(
			beta.map(row => row.tabId),
			["tab:beta"],
		);
	});

	it("orders running conversations before stopped ones and keeps tab order inside each group", async () => {
		const stoppedLater = entry({ tabId: "tab:s2", cwd: ALPHA, kind: "session", sessionFile, ordinal: 4 });
		const runningEarlier = entry({
			tabId: "tab:r1",
			cwd: ALPHA,
			kind: "session",
			sessionFile,
			ordinal: 1,
			availability: "live",
			runIntent: "running",
		});
		const runningLater = entry({
			tabId: "tab:r2",
			cwd: ALPHA,
			kind: "session",
			sessionFile,
			ordinal: 3,
			availability: "live",
			runIntent: "running",
		});
		const stoppedEarlier = entry({ tabId: "tab:s1", cwd: ALPHA, kind: "session", sessionFile, ordinal: 2 });
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [stoppedLater, runningEarlier, runningLater, stoppedEarlier],
			running: new Set(["tab:r1", "tab:r2"]),
		});
		const children = await rowsOf(provider, roots[0]!);
		assert.deepEqual(
			children.map(row => row.tabId),
			["tab:r1", "tab:r2", "tab:s1", "tab:s2"],
		);
	});

	it("names a row by OMP's title, then the last observed one, then the ordinal label", async () => {
		const titled = entry({ tabId: "tab:titled", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" });
		const cached = entry({
			tabId: "tab:cached",
			cwd: ALPHA,
			kind: "session",
			sessionFile: path.join(temp, "gone.jsonl"),
			availability: "saved",
			title: "Last observed title",
			ordinal: 7,
		});
		const untitled = entry({ tabId: "tab:untitled", cwd: ALPHA, ordinal: 12 });
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [titled, cached, untitled],
		});
		const children = await rowsOf(provider, roots[0]!);
		await waitForRows(provider, () => children[0]?.label === "OMP title wins");
		assert.equal(children[0]!.label, "OMP title wins");
		assert.equal(children[1]!.label, "Last observed title");
		// Never the folder name: two untitled conversations must stay distinct.
		assert.equal(children[2]!.label, "New session 12");
	});

	it("dispatches the admitted open path from a row, and never starts anything itself", async () => {
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [
				entry({ tabId: "tab:open", cwd: ALPHA, kind: "session", sessionFile, availability: "live", runIntent: "running" }),
				entry({ tabId: "tab:stopped", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" }),
			],
			running: new Set(["tab:open"]),
		});
		const rows = await rowsOf(provider, roots[0]!);
		const open = rows.find(row => row.tabId === "tab:open")!;
		const stopped = rows.find(row => row.tabId === "tab:stopped")!;
		assert.equal(open.command?.command, "omp.clickSession");
		assert.equal(stopped.command?.command, "omp.clickSession");
		assert.equal(stopped.command?.arguments?.[0], stopped);
		assert.equal(stopped.id, "tab:stopped");
	});

	it("keeps history deletion and Forget eligibility tied to row state", async () => {
		const fileRow = entry({ tabId: "tab:file", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" });
		const draftRow = entry({ tabId: "tab:draft", cwd: ALPHA });
		const runningRow = entry({
			tabId: "tab:running",
			cwd: BETA,
			kind: "session",
			sessionFile,
			availability: "live",
			runIntent: "running",
		});
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA), folder("folder:beta", BETA)],
			entries: [fileRow, draftRow, runningRow],
			running: new Set(["tab:running"]),
		});
		const alpha = await rowsOf(provider, roots[0]!);

		// Both offer Open; only a row with history can be deleted or viewed without launching.
		assert.equal(alpha[0]!.resumable, true);
		assert.equal(alpha[0]!.deletable, true);
		assert.equal(alpha[0]!.forgettable, true);
		assert.equal(alpha[1]!.resumable, true);
		assert.equal(alpha[1]!.deletable, false);

		const beta = await rowsOf(provider, roots[1]!);
		assert.equal(beta[0]!.resumable, true);
		assert.equal(beta[0]!.deletable, true);
		assert.equal(beta[0]!.forgettable, false);
	});



	it("shows a current other-window holder as Open in another window before Resume and after a refused attempt, never offering Release", async () => {
		const unresolved = {
			pid: 1234, startedAt: "2026-09-25T10:00:00.000Z",
			instanceId: null, generation: null, sessionId: null,
		};
		let remote = entry({
			tabId: "tab:remote", cwd: ALPHA, kind: "session", sessionFile,
			availability: "saved", runIntent: "running", host: unresolved,
		});
		let outcome: SessionLauncherFacts["outcome"] = null;
		let heldElsewhere = true;
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [remote],
			activeTabId: () => null,
			facts: () => ({ ...NO_FACTS, outcome }),
			observeOwnership: async () => ({ heldElsewhere, ownershipChecked: true }),
		});
		const assertHeld = async () => {
			const root = (await rootsOf(provider))[0]!;
			await waitForRows(provider, () => root.rows[0]?.state !== "checking");
			const row = await provider.itemFor(remote.tabId);
			assert.equal(row?.state, "otherWindow");
			assert.equal(row?.description, "Running · in another window");
			assert.equal(row?.resumable, false);
			assert.equal(row?.forgettable, false);
			assert.equal(row?.deletable, false);
			assert.equal(row?.command?.command, "omp.clickSession");
			const menu = contributedCommands(row!.contextValue!);
			assert.equal(menu.includes("omp.openSession"), false);
			assert.ok(menu.includes("omp.stopSessionHost"));
			assert.equal(menu.includes("omp.releaseStaleOwnership"), false);
			assert.ok(tooltipText(row!).split("\n").length <= 4);
			assert.doesNotMatch(tooltipText(row!), /claim|writer|broker|JSONL/i);
		};
		await assertHeld();
		remote = { ...remote, availability: "saved" };
		outcome = { status: "conflict", tabId: remote.tabId, kind: "claim-conflict", detail: "held by another live window" };
		provider.refresh();
		await assertHeld();
		// A genuinely unresolved reservation remains recoverable once no live rival is observed.
		heldElsewhere = false;
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => (provider.getChildren()[0] as FolderRow).rows[0]?.state === "stopped");
		assert.equal((await provider.itemFor(remote.tabId))?.state, "stopped");
		provider.dispose();
	});

	it("shows a plain omp outside this extension as Open in another OMP process, and only when nothing this extension owns can hold it", async () => {
		let externalOmp = true;
		let facts: SessionLauncherFacts = NO_FACTS;
		let observed: Partial<SessionLauncherFacts> = {};
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [entry({ tabId: "tab:terminal", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" })],
			activeTabId: () => null,
			facts: () => facts,
			observeOwnership: async () => ({ externalOmp, ownershipChecked: true, ...observed }),
		});
		const root = (await rootsOf(provider))[0]!;
		await waitForRows(provider, () => root.rows[0]?.state === "externalOmp");
		const row = root.rows[0]!;
		assert.equal(row.description, "Open in another OMP process");
		assert.equal(iconId(row), "terminal");
		assert.equal(row.resumable, false);
		assert.equal(row.forgettable, false);
		assert.equal(row.deletable, false);
		assert.equal(row.command?.command, "omp.clickSession");
		assert.ok(tooltipText(row).split("\n").length <= 4);
		assert.equal(JSON.parse(row.diagnostics).facts.externalOmp, true);
		assert.equal(provider.displayedState("tab:terminal"), "externalOmp");

		// Priority: another window's live claim names the holder, so that state wins.
		observed = { heldElsewhere: true };
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => root.rows[0]?.state === "otherWindow");
		// A writer this extension verified owns the lease: the row is its own Running row.
		observed = { ownedWriterPid: 4242 };
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => root.rows[0]?.state === "running");
		// A launch executing here holds the lease itself.
		observed = {};
		facts = { ...NO_FACTS, launching: true };
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => root.rows[0]?.state === "starting");
		// And a row this window runs is never an external one.
		facts = { ...NO_FACTS, running: true, open: true };
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => root.rows[0]?.state === "running");

		// The terminal exits: the next observation returns the row to its ordinary state.
		facts = NO_FACTS;
		externalOmp = false;
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => root.rows[0]?.state === "stopped");
		provider.dispose();
	});

	it("re-reads only the named rows' ownership and keeps the shown state until the new one arrives", async () => {
		const held = new Map<string, boolean>([["tab:one", true], ["tab:two", true]]);
		const observed: string[] = [];
		const gate = Promise.withResolvers<void>();
		let hold = false;
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [
				entry({ tabId: "tab:one", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" }),
				entry({ tabId: "tab:two", cwd: ALPHA, kind: "session", sessionFile, availability: "saved", ordinal: 1 }),
			],
			activeTabId: () => null,
			facts: () => NO_FACTS,
			observeOwnership: async tabId => {
				observed.push(tabId);
				if (hold) await gate.promise;
				return { heldElsewhere: held.get(tabId) === true, ownershipChecked: true };
			},
		});
		const root = (await rootsOf(provider))[0]!;
		await waitForRows(provider, () => root.rows.every(row => row.state === "otherWindow"));
		assert.equal(provider.displayedState("tab:one"), "otherWindow");
		assert.equal(provider.displayedState("tab:missing"), undefined);
		observed.length = 0;

		// The other window released tab:one; tab:two is untouched and must not be probed again.
		held.set("tab:one", false);
		hold = true;
		provider.refreshOwnership(new Set(["tab:one"]));
		await nextTurn();
		assert.deepEqual(observed, ["tab:one"]);
		const stateOf = (tabId: string) => root.rows.find(row => row.tabId === tabId)?.state;
		assert.equal(stateOf("tab:one"), "otherWindow", "the shown state stays until the new observation arrives");
		hold = false;
		gate.resolve();
		await waitForRows(provider, () => stateOf("tab:one") === "stopped");
		assert.equal(stateOf("tab:two"), "otherWindow");
		assert.deepEqual(observed, ["tab:one"]);

		// A tab the view does not show is ignored rather than invented.
		provider.refreshOwnership(new Set(["tab:missing"]));
		await nextTurn();
		assert.deepEqual(observed, ["tab:one"]);
		provider.dispose();
	});

	it("marks a pinned folder with the pin icon and offers exactly Unpin, and an unpinned one exactly Pin", async () => {
		const pinned = folder("folder:alpha", ALPHA, false, { pinned: true, open: true });
		const open = folder("folder:beta", BETA, false, { pinned: false, open: true });
		const { roots } = await build({ folders: [pinned, open], entries: [] });
		const [alpha, beta] = roots;
		assert.equal(iconId(alpha!), "pinned");
		assert.equal(iconId(beta!), "folder");
		assert.equal(alpha!.contextValue, "ompWorkspaceFolder.expanded.pinned");
		assert.equal(beta!.contextValue, "ompWorkspaceFolder.expanded.unpinned");
		const shared = ["omp.copyRowDiagnostics", "omp.newSession", "omp.newSession", "omp.resumeWorkspaceFolder", "omp.resumeWorkspaceFolder", "omp.openTerminal"];
		assert.deepEqual(contributedCommands(alpha!.contextValue!), [...shared, "omp.unpinWorkspaceFolder"]);
		assert.deepEqual(contributedCommands(beta!.contextValue!), [...shared, "omp.pinWorkspaceFolder", "omp.pinWorkspaceFolder"]);
		assert.ok(alpha!.accessibilityInformation?.label.includes("pinned"));
	});

	it("repaints a folder in place when it is pinned, keeping its id", async () => {
		let current = folder("folder:alpha", ALPHA, false, { pinned: false, open: true });
		const provider = providerFor({
			folders: () => [current],
			entries: () => [],
			activeTabId: () => null,
			facts: () => NO_FACTS,
		});
		const before = (await rootsOf(provider))[0]!;
		const fired: unknown[] = [];
		const subscription = provider.onDidChangeTreeData(element => fired.push(element));
		current = { ...current, pinned: true };
		provider.refresh();
		const after = (await rootsOf(provider))[0]!;
		assert.equal(after, before, "the same tree element survives pinning");
		assert.equal(after.id, "folder:alpha");
		assert.equal(after.contextValue, "ompWorkspaceFolder.expanded.pinned");
		assert.deepEqual(fired, [before], "only that folder is repainted");
		subscription.dispose();
	});


	it("offers Delete and Forget when an old running intent is now a saved file with no host", async () => {
		const old = entry({
			tabId: "tab:old-saved", cwd: ALPHA, kind: "session",
			sessionFile, availability: "saved", runIntent: "running", host: null,
		});
		const { provider, roots } = await build({ folders: [folder("folder:alpha", ALPHA)], entries: [old] });
		const row = (await rowsOf(provider, roots[0]!))[0]!;
		assert.equal(row.state, "stopped");
		assert.equal(row.contextValue, "ompSession.forgettable.stopped.resumable.deletable.materialized.view-none");
		assert.equal(JSON.parse(row.diagnostics).state, "stopped");
		assert.ok(tooltipText(row).split("\n").length <= 4);
	});

	it("shows a stopped conversation as stopped even while the guest reports activity", async () => {
		const stoppedBusy = entry({ tabId: "tab:stopped", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" });
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [stoppedBusy],
			running: new Set(),
			activities: new Map([
				["tab:stopped", activity({ pendingQuestion: true, working: true, lastCompletedReplyId: "r2", lastSeenReplyId: "r1" })],
			]),
		});
		const [row] = await rowsOf(provider, roots[0]!);
		// The durable intent wins: a stopped row never looks busy, unread or waiting.
		assert.equal(row!.state, "stopped");
		const icon = row!.iconPath;
		assert.ok(icon !== null && typeof icon === "object" && "id" in icon, "a stopped row carries its own icon");
		assert.equal(icon.id, "circle-slash");
		assert.equal(row!.resumable, true);
		assert.equal(row!.deletable, true, "guest activity is not ownership");
	});

	it("ranks structured asks above work, while prose questions remain ordinary idle replies", async () => {
		const live = (tabId: string): SessionIndexEntry =>
			entry({ tabId, cwd: ALPHA, kind: "session", sessionFile, availability: "live", runIntent: "running" });
		const pending = live("tab:pending");
		const streaming = live("tab:streaming");
		const heuristic = live("tab:heuristic");
		const unread = live("tab:unread");
		const idle = live("tab:idle");
		const noActivity = live("tab:none");
		const { provider, roots } = await build({
			folders: [folder("folder:alpha", ALPHA)],
			entries: [pending, streaming, heuristic, unread, idle, noActivity],
			running: new Set(["tab:pending", "tab:streaming", "tab:heuristic", "tab:unread", "tab:idle", "tab:none"]),
			activities: new Map<string, SessionActivityFacts>([
				// A pending question is never hidden behind Working.
				["tab:pending", activity({ pendingQuestion: true, working: true })],
				["tab:streaming", activity({ working: true, trailingQuestion: true })],
				["tab:heuristic", activity({ trailingQuestion: true })],
				["tab:unread", activity({ lastCompletedReplyId: "reply-9", lastSeenReplyId: "reply-8" })],
				["tab:idle", activity({ lastCompletedReplyId: "reply-9", lastSeenReplyId: "reply-9" })],
			]),
		});
		const byTab = new Map((await rowsOf(provider, roots[0]!)).map(row => [row.tabId, row]));
		assert.equal(byTab.get("tab:pending")!.state, "question");
		assert.equal(byTab.get("tab:streaming")!.state, "working");
		assert.equal(byTab.get("tab:heuristic")!.state, "waiting");
		assert.equal(byTab.get("tab:unread")!.state, "unread");
		assert.equal(byTab.get("tab:idle")!.state, "waiting");
		assert.equal(byTab.get("tab:none")!.state, "running");
	});

	it("keeps background work above unread and true idle, with distinct visible state and guarded checking actions", () => {
		const indexed = entry({ tabId: "tab:work", cwd: ALPHA, kind: "session", sessionFile, availability: "live", runIntent: "running" });
		const facts: SessionLauncherFacts = { ...NO_FACTS, running: true, activity: activity({ working: true, backgroundWork: true, settled: false, lastCompletedReplyId: "new", lastSeenReplyId: "old" }) };
		let state = sessionTree.sessionItemState(indexed, facts);
		const row = new sessionTree.SessionTreeItem(indexed, state, { header: null, conversation: null, facts, active: false, now: 0 });
		assert.equal(state, "working");
		assert.equal(row.description, "Working");
		const waiting = { ...facts, activity: activity({ backgroundWork: true, settled: false, lastCompletedReplyId: "new", lastSeenReplyId: "old" }) };
		state = sessionTree.sessionItemState(indexed, waiting);
		row.update(indexed, state, { header: null, conversation: null, facts: waiting, active: false, now: 0 });
		assert.equal(state, "background");
		assert.equal(row.description, "Waiting for subagents");
		assert.equal(sessionTree.sessionItemState(indexed, { ...waiting, activity: activity({ pendingQuestion: true, backgroundWork: true, settled: false }) }), "question");
		assert.equal(sessionTree.sessionItemState(indexed, { ...facts, activity: activity({ settled: false }) }), "running");
		const idle = { ...facts, activity: activity({ trailingQuestion: true }) };
		state = sessionTree.sessionItemState(indexed, idle);
		row.update(indexed, state, { header: null, conversation: null, facts: idle, active: false, now: 0 });
		assert.equal(state, "waiting");
		const checking = { ...NO_FACTS, checking: true };
		state = sessionTree.sessionItemState(indexed, checking);
		row.update(indexed, state, { header: null, conversation: null, facts: checking, active: false, now: 0 });
		assert.equal(state, "checking");
		assert.equal(row.forgettable, false);
		assert.equal(row.deletable, false);
		assert.equal(row.resumable, true, "Open rechecks the existing lifecycle authority; checking does not offer live-only actions");
	});

	it("re-reads the registry on refresh, so adding and removing a folder is what the tree shows", async () => {
		const registered: LauncherFolder[] = [folder("folder:alpha", ALPHA)];
		const provider = providerFor({
			folders: () => registered,
			entries: () => [],
			activeTabId: () => null,
			facts: () => NO_FACTS,
		});
		assert.deepEqual(
			(await rootsOf(provider)).map(root => root.id),
			["folder:alpha"],
		);
		registered.push(folder("folder:beta", BETA));
		let changes = 0;
		const subscription = provider.onDidChangeTreeData(() => {
			changes++;
		});
		provider.refresh();
		assert.equal(changes, 1);
		assert.deepEqual(
			(await rootsOf(provider)).map(root => root.id),
			["folder:alpha", "folder:beta"],
		);
		registered.shift();
		provider.refresh();
		assert.deepEqual(
			(await rootsOf(provider)).map(root => root.id),
			["folder:beta"],
		);
		subscription.dispose();
		provider.dispose();
	});

	it("marks only a folder with a recoverable detached shell, keeping the menu contract", async () => {
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA), folder("folder:beta", BETA)],
			entries: () => [],
			activeTabId: () => null,
			facts: () => NO_FACTS,
			hasRecoverableShell: candidate => candidate.id === "folder:alpha",
		});
		const [alpha, beta] = await rootsOf(provider);
		// The Reconnect Terminal condition matches exactly this segment, and a folder
		// without a detached shell keeps the plain vocabulary (Open Terminal is always
		// a new shell).
		assert.equal(alpha!.contextValue, "ompWorkspaceFolder.shells.expanded.pinned");
		assert.equal(alpha!.hasRecoverableShell, true);
		assert.equal(beta!.contextValue, "ompWorkspaceFolder.expanded.pinned");
		assert.equal(beta!.hasRecoverableShell, false);
		// A source that knows nothing about folder shells reports none.
		const unaware = await build({ folders: [folder("folder:alpha", ALPHA)], entries: [] });
		assert.equal((await rootsOf(unaware.provider))[0]!.contextValue, "ompWorkspaceFolder.expanded.pinned");
	});

	it("derives folders from the registry alone, never from an indexed session", async () => {
		// The same registry the extension builds: while it holds no folder, the
		// launcher renders nothing however many sessions the index knows.
		const registry = stubRegistry([ALPHA]);
		const provider = providerFor({
			folders: () => pinnedFolders(registry),
			entries: () => [entry({ tabId: "tab:known", cwd: ALPHA })],
			activeTabId: () => "tab:known",
			facts: () => NO_FACTS,
		});
		assert.deepEqual(await provider.getChildren(), []);
		await registry.add(ALPHA);
		provider.refresh();
		const roots = await rootsOf(provider);
		assert.deepEqual(
			roots.map(root => root.id),
			registry.list().map(registered => registered.id),
		);
		assert.deepEqual(
			(await rowsOf(provider, roots[0]!)).map(row => row.tabId),
			["tab:known"],
		);
	});

	it("files sessions recorded in an opened subfolder under the agent-root folder shown instead, unless another folder names the subfolder", async () => {
		const unity = path.join(ALPHA, "Unity");
		const root: LauncherFolder = { ...folder("folder:root", ALPHA, false, { pinned: false, open: true }), openedPaths: [unity] };
		const provider = providerFor({
			folders: () => [root],
			entries: () => [entry({ tabId: "tab:sub", cwd: unity }), entry({ tabId: "tab:root", cwd: ALPHA, ordinal: 1 })],
			activeTabId: () => "tab:sub",
			facts: () => NO_FACTS,
		});
		const [shown] = await rootsOf(provider);
		assert.deepEqual((await rowsOf(provider, shown!)).map(row => row.tabId), ["tab:sub", "tab:root"]);
		const tip = tooltipText(shown!);
		assert.ok(tip.includes(`Shown instead of the opened "${unity}" because the repository's agent files are here.`), tip);

		const pinnedSub = folder("folder:sub", unity);
		const split = providerFor({
			folders: () => [root, pinnedSub],
			entries: () => [entry({ tabId: "tab:sub", cwd: unity })],
			activeTabId: () => "tab:sub",
			facts: () => NO_FACTS,
		});
		const [first, second] = await rootsOf(split);
		assert.ok((await rowsOf(split, first!)).every(row => !(row instanceof sessionTree.SessionTreeItem)), "the pinned subfolder keeps its own sessions");
		assert.deepEqual((await rowsOf(split, second!)).map(row => row.tabId), ["tab:sub"]);
	});

	const FIXED_NOW = Date.parse("2026-09-25T10:10:00.000Z");

	it("serves persisted rows before any probe or header read, and enriches rows independently", async () => {
		const blocked = Promise.withResolvers<{ ownershipChecked: boolean; heldElsewhere: boolean }>();
		const calls: string[] = [];
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [
				entry({ tabId: "tab:slow", cwd: ALPHA, kind: "session", sessionFile, title: "Persisted title" }),
				entry({ tabId: "tab:fast", cwd: ALPHA, ordinal: 1 }),
			],
			activeTabId: () => "tab:slow",
			facts: () => NO_FACTS,
			observeOwnership: tabId => {
				calls.push(tabId);
				return tabId === "tab:slow" ? blocked.promise : Promise.resolve({ ownershipChecked: true });
			},
		});
		const roots = provider.getChildren() as FolderRow[];
		const rows = provider.getChildren(roots[0]) as SessionRow[];
		assert.deepEqual(rows.map(row => [row.tabId, row.label, row.state]), [
			["tab:slow", "Persisted title", "checking"], ["tab:fast", "New session 1", "checking"],
		]);
		assert.deepEqual(calls, [], "the first projection invokes neither ownership nor file enrichment");
		await waitForRows(provider, () => rows[1]?.state === "draft");
		assert.equal(rows[0]!.state, "checking", "a blocked observation cannot hold another row");
		await waitForRows(provider, () => rows[0]?.label === "OMP title wins");
		assert.equal(provider.headlineFor("tab:slow"), rows[0]?.label, "Processes and detail tabs reuse the file-observed name");
		assert.equal(provider.headlineFor("tab:missing"), undefined);
		assert.equal(rows[0]!.state, "checking", "file enrichment has its own queue");
		blocked.resolve({ ownershipChecked: true, heldElsewhere: true });
		await waitForRows(provider, () => rows[0]?.state === "otherWindow");
		assert.equal(rows[0]!.forgettable, false);
	});

	it("bounds ownership work and coalesces repeated invalidations to one follow-up per tab", async () => {
		const entries = Array.from({ length: 6 }, (_, ordinal) => entry({ tabId: `tab:${ordinal}`, cwd: ALPHA, ordinal }));
		const flights: { tabId: string; resolve(value: { ownershipChecked: boolean }): void }[] = [];
		const followUp = Promise.withResolvers<void>();
		const nextRow = Promise.withResolvers<void>();
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => entries,
			activeTabId: () => null,
			facts: () => NO_FACTS,
			observeOwnership: tabId => new Promise(resolve => {
				flights.push({ tabId, resolve });
				if (flights.length === 5) followUp.resolve();
				if (flights.length === 6) nextRow.resolve();
			}),
		});
		provider.getChildren();
		await nextTurn();
		assert.deepEqual(flights.map(flight => flight.tabId), ["tab:0", "tab:1", "tab:2", "tab:3"]);
		for (let count = 0; count < 5; count++) provider.refresh({ ownership: true });
		await nextTurn();
		assert.equal(flights.length, 4, "refresh cannot create overlapping probes");
		flights[0]!.resolve({ ownershipChecked: true });
		await followUp.promise;
		assert.deepEqual(flights.map(flight => flight.tabId), ["tab:0", "tab:1", "tab:2", "tab:3", "tab:0"]);
		flights[4]!.resolve({ ownershipChecked: true });
		await nextRow.promise;
		assert.equal(flights[5]!.tabId, "tab:4", "the dirty bit is consumed once, not once per refresh");
		provider.dispose();
	});

	it("rejects stale ownership across runtime rebinding and remove/re-add without overlapping flights", async () => {
		let entries = [entry({ tabId: "tab:one", cwd: ALPHA })];
		let runtimeIdentity = "old";
		const flights: { resolve(value: { ownershipChecked: boolean; heldElsewhere: boolean }): void }[] = [];
		const replacementStarted = Promise.withResolvers<void>();
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => entries,
			activeTabId: () => null,
			facts: () => NO_FACTS,
			runtimeIdentity: () => runtimeIdentity,
			observeOwnership: () => new Promise(resolve => {
				flights.push({ resolve });
				if (flights.length === 2) replacementStarted.resolve();
			}),
		});
		const root = (provider.getChildren() as FolderRow[])[0]!;
		await nextTurn();
		runtimeIdentity = "new";
		provider.refresh();
		entries = [];
		provider.refresh();
		entries = [entry({ tabId: "tab:one", cwd: ALPHA, title: "Replacement" })];
		provider.refresh();
		await nextTurn();
		assert.equal(flights.length, 1);
		flights[0]!.resolve({ ownershipChecked: true, heldElsewhere: true });
		await replacementStarted.promise;
		assert.equal(root.rows[0]!.label, "Replacement");
		assert.equal(root.rows[0]!.state, "checking", "the removed binding cannot block its replacement");
		assert.equal(flights.length, 2);
		flights[1]!.resolve({ ownershipChecked: true, heldElsewhere: false });
		await waitForRows(provider, () => root.rows[0]?.state === "draft");
	});

	it("merges fresh local activity rather than restoring facts captured by a pending probe", async () => {
		const pending = Promise.withResolvers<{ ownershipChecked: boolean; heldElsewhere: boolean }>();
		let facts = NO_FACTS;
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [entry({ tabId: "tab:one", cwd: ALPHA, availability: "live", runIntent: "running" })],
			activeTabId: () => null,
			facts: () => facts,
			observeOwnership: () => pending.promise,
		});
		const root = (provider.getChildren() as FolderRow[])[0]!;
		await nextTurn();
		facts = { ...NO_FACTS, running: true, activity: activity({ pendingQuestion: true, backgroundWork: true, settled: false }) };
		provider.refresh();
		pending.resolve({ ownershipChecked: true, heldElsewhere: true });
		await nextTurn();
		assert.equal(root.rows[0]!.state, "question");
		assert.equal(root.rows[0]!.description, "Needs your answer");
	});

	it("refreshes only a row for activity, a folder for reordered children, and roots for folder membership", async () => {
		let backgroundWork = false;
		let remotePid: number | null = null;
		let probes = 0;
		const registered = [folder("folder:alpha", ALPHA)];
		const provider = providerFor({
			folders: () => registered,
			entries: () => [entry({ tabId: "tab:remote", cwd: ALPHA }), entry({ tabId: "tab:local", cwd: ALPHA, ordinal: 1, runIntent: "running" })],
			activeTabId: () => null,
			facts: tabId => tabId === "tab:local" ? {
				...NO_FACTS, running: true, activity: activity({ working: !backgroundWork, backgroundWork, settled: false }),
			} : NO_FACTS,
			observeOwnership: async () => { probes++; return { ownershipChecked: true, ownedWriterPid: remotePid }; },
		});
		const root = (provider.getChildren() as FolderRow[])[0]!;
		await waitForRows(provider, () => root.rows[1]?.state === "draft");
		const changes: unknown[] = [];
		const subscription = provider.onDidChangeTreeData(item => { changes.push(item); });
		backgroundWork = true;
		provider.refresh();
		await nextTurn();
		assert.equal(probes, 1);
		assert.deepEqual(changes, [root.rows[0]]);
		assert.equal(root.rows[0]!.state, "background");
		changes.length = 0;
		remotePid = 123;
		provider.refresh({ ownership: true });
		await waitForRows(provider, () => root.rows[0]?.tabId === "tab:remote");
		assert.deepEqual(changes, [root]);
		changes.length = 0;
		registered.push(folder("folder:beta", BETA));
		provider.refresh();
		assert.deepEqual(changes, [undefined]);
		subscription.dispose();
	});

	it("reserves only actually served reveal paths, deferring structural refresh until release and respecting collapse", async () => {
		const registered = [folder("folder:alpha", ALPHA)];
		const entries = [entry({ tabId: "tab:one", cwd: ALPHA, runIntent: "running" })];
		const provider = providerFor({
			folders: () => registered, entries: () => entries, activeTabId: () => "tab:one",
			facts: () => ({ ...NO_FACTS, running: true, activity: activity() }),
		});
		await provider.itemFor("tab:one");
		assert.equal(provider.beginReveal("tab:one"), undefined, "construction is not root publication");
		const root = (provider.getChildren() as FolderRow[])[0]!;
		await nextTurn();
		assert.equal(provider.beginReveal("tab:one"), undefined, "the target folder has not served children");
		provider.getChildren(root);
		assert.equal(provider.beginReveal("tab:one"), undefined, "the provider return precedes child registration");
		await nextTurn();
		const reservation = provider.beginReveal("tab:one")!;
		assert.equal(reservation.item.tabId, "tab:one");
		registered.push(folder("folder:beta", BETA));
		provider.refresh();
		assert.deepEqual(provider.getChildren().map(item => item.id), ["folder:alpha"], "an active reveal keeps its parent fetch intact");
		reservation.release();
		assert.equal(provider.beginReveal("tab:one"), undefined, "root refresh rearms both publication barriers");
		assert.deepEqual(provider.getChildren().map(item => item.id), ["folder:alpha", "folder:beta"]);
		provider.getChildren(root);
		await nextTurn();
		const newReservation = provider.beginReveal("tab:one")!;
		assert.notEqual(newReservation.pathKey, reservation.pathKey);
		newReservation.release();
		registered[0] = { ...registered[0]!, collapsed: true };
		provider.refresh();
		provider.getChildren(root);
		await nextTurn();
		assert.equal(provider.beginReveal("tab:one"), undefined, "automatic selection never expands a saved collapsed folder");
		// The reveal that answers the user activating the session may expand it. VS Code never
		// fetches a collapsed folder's children, so only the published roots are required.
		const expanding = provider.beginReveal("tab:one", { expand: true })!;
		assert.equal(expanding.item.tabId, "tab:one");
		expanding.release();
		assert.equal(provider.beginReveal("tab:one"), undefined, "the expansion was granted once, not left on");
	});

	it("keeps cached reveal paths current across title, state, selection and membership changes", async () => {
		let activeTabId: string | null = "tab:one";
		let registered = folder("folder:alpha", ALPHA);
		const entries = [
			entry({ tabId: "tab:one", cwd: ALPHA, title: "Original" }),
			entry({ tabId: "tab:two", cwd: ALPHA, title: "Second", ordinal: 1 }),
		];
		const facts = new Map<string, SessionLauncherFacts>();
		const provider = providerFor({
			folders: () => [registered],
			entries: () => entries,
			activeTabId: () => activeTabId,
			facts: tabId => facts.get(tabId) ?? NO_FACTS,
		}, { now: () => FIXED_NOW });
		const cachedFolder = (await rootsOf(provider))[0]!;
		const cachedRow = (await provider.itemFor("tab:one"))!;

		entries[0] = { ...entries[0]!, title: "Renamed" };
		provider.refresh();
		const renamedRoots = await rootsOf(provider);
		assert.equal(provider.getParent(cachedRow), renamedRoots[0]);
		assert.ok((await rowsOf(provider, cachedFolder)).includes(cachedRow));
		assert.equal(cachedRow.label, "Renamed");

		facts.set("tab:one", { ...NO_FACTS, open: true, running: true, activity: activity({ working: true }) });
		activeTabId = "tab:two";
		registered = { ...registered, collapsed: true };
		entries.push(entry({ tabId: "tab:three", cwd: ALPHA, ordinal: 2 }));
		provider.refresh();
		const currentRoots = await rootsOf(provider);
		assert.equal(provider.getParent(cachedRow), currentRoots[0], "an in-flight reveal can still walk its cached row");
		const currentChildren = await rowsOf(provider, cachedFolder);
		assert.deepEqual(currentChildren.map(row => row.tabId), ["tab:one", "tab:two", "tab:three"]);
		assert.ok(currentChildren.includes(cachedRow));
		assert.equal(cachedRow.state, "working");
		assert.match(cachedRow.contextValue!, /held\.working/);
		assert.equal(JSON.parse(cachedRow.diagnostics).active, false);
		assert.equal(cachedFolder.collapsibleState, TreeItemCollapsibleState.Collapsed);
		const selected = (await provider.itemFor("tab:two"))!;
		assert.equal(JSON.parse(selected.diagnostics).active, true);

		entries.shift();
		provider.refresh();
		await rootsOf(provider);
		assert.equal(provider.getParent(cachedRow), undefined, "a removed session is not revealable");
		assert.equal(await provider.itemFor("tab:one"), undefined);
		assert.deepEqual((await rowsOf(provider, cachedFolder)).map(row => row.tabId), ["tab:two", "tab:three"]);
	});


	it("keeps the selected row locateable and revealable through a refresh", async () => {
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [
				entry({ tabId: "tab:one", cwd: ALPHA, kind: "session", sessionFile, availability: "saved" }),
				entry({ tabId: "tab:two", cwd: ALPHA, kind: "session", sessionFile, availability: "saved", ordinal: 1 }),
			],
			activeTabId: () => "tab:two",
			facts: () => NO_FACTS,
		}, { now: () => FIXED_NOW });
		const roots = await rootsOf(provider);
		const selected = await provider.itemFor("tab:two");
		assert.ok(selected !== undefined);
		// This is the walk `TreeView.reveal` performs: from the row up to its parent.
		assert.equal(provider.getParent(selected), roots[0]);

		provider.refresh();
		// A reveal that lands before the replacement is published still walks to the
		// row: nothing the view holds was discarded up front.
		assert.equal(provider.getParent(selected), roots[0], "the row is still locatable while its replacement is built");

		const rebuiltRoots = await rootsOf(provider);
		const rebuiltSelection = await provider.itemFor("tab:two");
		assert.ok(rebuiltSelection !== undefined);
		assert.equal(
			provider.getParent(rebuiltSelection),
			rebuiltRoots[0],
			"the selected row is still revealable after the rebuild",
		);
		assert.equal(JSON.parse(rebuiltSelection.diagnostics).active, true);
	});

	it("shows the conversation's own last activity: bookkeeping touches never move it, the session file does", async () => {
		const file = path.join(temp, "2026-09-25T08-00-00-000Z_activity.jsonl");
		const message = (timestamp: string, role: string) =>
			JSON.stringify({ type: "message", id: timestamp.slice(11, 19), parentId: null, timestamp, message: { role, content: "text" } });
		await fs.promises.writeFile(file, [
			JSON.stringify({ type: "session", id: "activity", timestamp: "2026-09-25T07:59:00.000Z", cwd: ALPHA }),
			message("2026-09-25T08:00:00.000Z", "user"),
			message("2026-09-25T08:00:05.000Z", "assistant"),
			// OMP appends this when the host exits; it is not the conversation advancing.
			JSON.stringify({ type: "custom", customType: "session_exit", data: { reason: "dispose" }, id: "x", parentId: null, timestamp: "2026-09-25T11:59:00.000Z" }),
		].map(line => `${line}\n`).join(""), "utf8");
		const now = Date.parse("2026-09-25T12:00:00.000Z");
		let idle = entry({ tabId: "tab:idle", cwd: ALPHA, kind: "session", sessionFile: file, availability: "saved", lastActiveAt: "2026-09-25T08:00:05.000Z" });
		const draft = entry({ tabId: "tab:draft", cwd: ALPHA, ordinal: 1, lastActiveAt: "2026-09-25T11:59:59.000Z" });
		const provider = providerFor({
			folders: () => [folder("folder:alpha", ALPHA)],
			entries: () => [idle, draft],
			activeTabId: () => null,
			facts: () => NO_FACTS,
		}, { now: () => now });
		const root = (await rootsOf(provider))[0]!;
		const row = (tabId: string) => root.rows.find(candidate => candidate.tabId === tabId)!;
		const lastActivity = (iso: string) => `Last activity: ${sessionTree.relativeAge(iso, now)}`;
		await waitForRows(provider, () => tooltipText(row("tab:idle")).includes(lastActivity("2026-09-25T08:00:05.000Z")));
		assert.ok(tooltipText(row("tab:draft")).includes("No activity yet"), "a draft without a file has no conversation yet");
		assert.ok(tooltipText(root).includes(lastActivity("2026-09-25T08:00:05.000Z")), "the folder takes its latest conversation, not a draft's bookkeeping");

		// Restore, reattach and focus touch the row's bookkeeping time; the hover must not follow it.
		idle = { ...idle, lastActiveAt: new Date(now).toISOString(), detail: "Reattached to the recorded host." };
		provider.refresh();
		assert.ok(tooltipText(row("tab:idle")).includes(lastActivity("2026-09-25T08:00:05.000Z")), tooltipText(row("tab:idle")));
		assert.ok(!tooltipText(row("tab:idle")).includes(lastActivity(new Date(now).toISOString())));

		// The conversation advances: the next refresh follows the session file.
		await fs.promises.appendFile(file, `${message("2026-09-25T11:30:00.000Z", "user")}\n`, "utf8");
		provider.refresh();
		await waitForRows(provider, () => tooltipText(row("tab:idle")).includes(lastActivity("2026-09-25T11:30:00.000Z")));
		assert.ok(tooltipText(root).includes(lastActivity("2026-09-25T11:30:00.000Z")));
		assert.equal(JSON.parse(row("tab:idle").diagnostics).conversation.lastAt, "2026-09-25T11:30:00.000Z");
	});

	describe("flat list", () => {
		const row = (tabId: string, cwd: string, overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry =>
			entry({ tabId, cwd, kind: "session", sessionFile, availability: "saved", ...overrides });
		const live = { availability: "live", runIntent: "running" } as const;

		function flatProvider(options: {
			readonly folders: readonly LauncherFolder[];
			readonly entries: readonly SessionIndexEntry[];
			readonly running?: ReadonlySet<string>;
			readonly grouping?: () => "flat" | "folders";
		}): Provider {
			return providerFor({
				folders: () => options.folders,
				entries: () => options.entries,
				activeTabId: () => null,
				facts: tabId => ({ open: false, running: options.running?.has(tabId) ?? false, outcome: null, activity: null }),
				grouping: options.grouping ?? (() => "flat"),
			});
		}

		it("shows one row per session of every folder, labelled by folder, live rows by unread then recency, stopped rows last", async () => {
			const entries = [
				row("tab:stopped-new", ALPHA, { ordinal: 1, lastActiveAt: "2026-09-25T12:00:00.000Z" }),
				row("tab:live-old", ALPHA, { ...live, ordinal: 2, lastActiveAt: "2026-09-25T08:00:00.000Z" }),
				row("tab:live-new", BETA, { ...live, ordinal: 3, lastActiveAt: "2026-09-25T11:00:00.000Z" }),
				row("tab:live-unread", BETA, { ...live, ordinal: 4, lastActiveAt: "2026-09-25T07:00:00.000Z", lastCompletedReplyId: "event-1" }),
				row("tab:stopped-old", BETA, { ordinal: 5, lastActiveAt: "2026-09-25T06:00:00.000Z" }),
				row("tab:elsewhere", UNREGISTERED, { ...live }),
			];
			const provider = flatProvider({
				folders: [folder("folder:alpha", ALPHA), folder("folder:beta", BETA)],
				entries,
				running: new Set(["tab:live-old", "tab:live-new", "tab:live-unread"]),
			});
			provider.getChildren();
			await waitForRows(provider, () => (provider.getChildren() as SessionRow[]).every(item => !("state" in item) || item.state !== "checking"));
			const children = provider.getChildren();
			assert.deepEqual(children.map(child => child.id), [
				"tab:live-unread", "tab:live-new", "tab:live-old", "tab:stopped-new", "tab:stopped-old", "omp.newSessionRow",
			]);
			const sessions = children.slice(0, 5) as SessionRow[];
			assert.deepEqual(sessions.map(item => String(item.label).split(" · ")[0]), ["beta", "beta", "alpha", "alpha", "beta"]);
			assert.ok(sessions.every(item => String(item.label).includes(" · ")));
			assert.deepEqual(sessions.map(item => item.unread), [true, false, false, false, false]);
			assert.equal(sessions[0]!.state, "running");
			assert.equal(sessions[0]!.description, "Unread · Running");
			assert.ok(tooltipText(sessions[0]!).includes("Unread reply"));
			assert.equal(sessions[1]!.description, "Running");
			const badge = provider.decorations.provideFileDecoration(sessions[0]!.resourceUri!, undefined as never) as { badge: string; tooltip: string };
			assert.deepEqual([badge.badge, badge.tooltip], ["●", "Unread reply"]);
			assert.equal(provider.decorations.provideFileDecoration(sessions[1]!.resourceUri!, undefined as never), undefined);
			assert.equal(provider.getParent(sessions[0]!), undefined);
			assert.deepEqual(provider.getChildren(sessions[0]!), []);
		});

		it("ends with a New Session row that asks for the folder through omp.newSession, and is empty without folders", async () => {
			const provider = flatProvider({ folders: [folder("folder:alpha", ALPHA)], entries: [] });
			const [newSession] = provider.getChildren();
			assert.ok(newSession instanceof sessionTree.NewSessionTreeItem);
			assert.equal(newSession.command?.command, "omp.newSession");
			assert.equal(newSession.command?.arguments, undefined);
			assert.deepEqual(flatProvider({ folders: [], entries: [] }).getChildren(), []);
		});

		it("switches between the flat list and folder nodes on refresh, restoring each row's own label", async () => {
			let grouping: "flat" | "folders" = "flat";
			const provider = flatProvider({
				folders: [folder("folder:alpha", ALPHA)],
				entries: [row("tab:one", ALPHA)],
				grouping: () => grouping,
			});
			const changes: unknown[] = [];
			provider.onDidChangeTreeData(element => changes.push(element));
			assert.ok(String(provider.getChildren()[0]!.label).startsWith("alpha · "));
			grouping = "folders";
			provider.refresh();
			assert.deepEqual(changes, [undefined]);
			const roots = provider.getChildren();
			assert.ok(roots[0] instanceof sessionTree.WorkspaceFolderTreeItem);
			const [item] = provider.getChildren(roots[0]!) as SessionRow[];
			assert.ok(!String(item!.label).includes(" · "));
			assert.equal(provider.getParent(item!), roots[0]);
			grouping = "flat";
			provider.refresh();
			assert.ok(String(provider.getChildren()[0]!.label).startsWith("alpha · "));
		});

		it("tells apart two folders with the same name in the row labels", () => {
			const one = path.join(os.tmpdir(), "omp-launcher-tree", "one", "app");
			const two = path.join(os.tmpdir(), "omp-launcher-tree", "two", "app");
			const provider = flatProvider({
				folders: [folder("folder:one", one), folder("folder:two", two)],
				entries: [row("tab:a", one, { ordinal: 1 }), row("tab:b", two, { ordinal: 2 })],
			});
			const labels = provider.getChildren().slice(0, 2).map(item => String(item.label).split(" · ")[0]);
			assert.deepEqual(labels.sort(), ["one/app", "two/app"]);
		});

		it("lists the sessions for the picker in the flat order with their folders, whichever grouping the view uses", async () => {
			let grouping: "flat" | "folders" = "folders";
			const provider = flatProvider({
				folders: [folder("folder:alpha", ALPHA), folder("folder:beta", BETA)],
				entries: [
					row("tab:stopped", ALPHA, { ordinal: 1, lastActiveAt: "2026-09-25T12:00:00.000Z" }),
					row("tab:live", ALPHA, { ...live, ordinal: 2, lastActiveAt: "2026-09-25T08:00:00.000Z" }),
					row("tab:unread", BETA, { ...live, ordinal: 3, lastActiveAt: "2026-09-25T07:00:00.000Z", lastCompletedReplyId: "event-1" }),
				],
				running: new Set(["tab:live", "tab:unread"]),
				grouping: () => grouping,
			});
			const listed = () => provider.listedSessions().map(({ item, folder: name }) => [item.tabId, name, item.headline === String(item.label)]);
			for (let turn = 0; turn < 20 && provider.listedSessions().some(({ item }) => item.state === "checking"); turn++) await nextTurn();
			assert.deepEqual(listed(), [["tab:unread", "beta", true], ["tab:live", "alpha", true], ["tab:stopped", "alpha", true]]);
			grouping = "flat";
			provider.refresh();
			assert.deepEqual(listed().map(([tabId, name]) => [tabId, name]), [["tab:unread", "beta"], ["tab:live", "alpha"], ["tab:stopped", "alpha"]]);
			assert.deepEqual(flatProvider({ folders: [folder("folder:alpha", ALPHA)], entries: [] }).listedSessions(), []);
		});

		it("reveals a session at the root once the root is served, and marks a read row as not unread", async () => {
			const provider = flatProvider({
				folders: [folder("folder:alpha", ALPHA)],
				entries: [row("tab:seen", ALPHA, { lastCompletedReplyId: "event-1", lastSeenReplyId: "event-1" })],
			});
			const [item] = provider.getChildren() as SessionRow[];
			assert.equal(item!.unread, false);
			assert.equal(provider.beginReveal("tab:seen"), undefined, "the root is not served yet");
			await nextTurn();
			const reserved = provider.beginReveal("tab:seen");
			assert.equal(reserved?.item, item);
			reserved?.release();
		});
	});
});
