/**
 * Behavioral tests for the Processes tree.
 *
 * What is worth defending is what a row is *allowed to say*: the provider shows the
 * snapshot's rows flat, in the model's order and under the model's ids, and words,
 * icons and the menu context follow from the row's own facts. A process that cannot be
 * stopped here says why in its tooltip and offers no stop context; text taken from a
 * title or a folder can never become Markdown or a link.
 *
 * The provider imports the editor API, so this file must run under `node --test` (the
 * module hooks below are Node's), against the stand-in `vscode` module.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { describe, it } from "node:test";

import type { BrokerProcessHost, BrokerProcessRow, BrokerProcessSnapshot } from "../host/broker-processes.ts";
import type { ProcessTreeItem, ProcessTreeProvider } from "./process-tree.ts";

// The provider imports the editor API, so the `vscode` specifier is mapped before it
// is loaded, and its own extensionless imports are given the extension Node needs.
// Both hooks must exist before the first import of the provider, which is why the
// import below is dynamic: a static import is evaluated first.
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

const { ThemeIcon } = await import("./vscode-test-stub.ts");
const processTree = await import("./process-tree.ts");

const BASE: BrokerProcessRow = {
	id: "current|host:a|broker-a",
	source: "current",
	kind: "session",
	ptyKind: "managed-rpc",
	slot: "host:a",
	brokerId: "broker-a",
	generation: "gen-1",
	brokerPid: 4242,
	brokerCreationTime: "133000000000000000",
	startedAt: "2026-10-07T08:00:00.000Z",
	uptimeMs: 3 * 60 * 1000,
	title: null,
	status: "in-use",
	host: null,
	window: "none",
	drivenHere: false,
	child: "running",
	olderBuild: false,
	stop: { available: true },
};

const SESSION_HOST: BrokerProcessHost = {
	kind: "session",
	tabId: "tab-1",
	title: "Fix the build",
	folder: "C:\\work\\repo",
	window: "this-window",
	drivenHere: true,
	recorded: true,
};

const TERMINAL_HOST: BrokerProcessHost = {
	kind: "terminal",
	folder: "C:\\work\\repo",
	label: "repo",
	window: "other-window",
};

function row(overrides: Partial<BrokerProcessRow>): BrokerProcessRow {
	return { ...BASE, ...overrides };
}

function snapshot(rows: readonly BrokerProcessRow[]): BrokerProcessSnapshot {
	return { rows, hidden: 0, unreadable: 0, takenAt: 0 };
}

function itemFor(overrides: Partial<BrokerProcessRow>): ProcessTreeItem {
	const provider = new processTree.ProcessTreeProvider();
	provider.setSnapshot(snapshot([row(overrides)]));
	const [item] = provider.getChildren();
	provider.dispose();
	assert.ok(item);
	return item;
}

function tooltipText(item: ProcessTreeItem): string {
	assert.equal(typeof item.tooltip, "string");
	return item.tooltip as string;
}

function iconOf(item: ProcessTreeItem): { id: string; color?: string } {
	assert.ok(item.iconPath instanceof ThemeIcon);
	return { id: item.iconPath.id, ...(item.iconPath.color ? { color: item.iconPath.color.id } : {}) };
}

describe("ProcessTreeProvider rows", () => {
	it("serves one flat row per snapshot row, in the given order, under the row ids", () => {
		const provider: ProcessTreeProvider = new processTree.ProcessTreeProvider();
		const rows = [
			row({ id: "r3", brokerPid: 3 }),
			row({ id: "r1", brokerPid: 1 }),
			row({ id: "r2", brokerPid: 2 }),
		];
		provider.setSnapshot(snapshot(rows));
		const children = provider.getChildren();
		assert.deepEqual(children.map(item => item.id), ["r3", "r1", "r2"]);
		assert.deepEqual(children.map(item => item.row.brokerPid), [3, 1, 2]);
		assert.deepEqual(provider.getChildren().map(item => item.id), ["r3", "r1", "r2"], "ids are stable across reads");
		for (const item of children) {
			assert.equal(provider.getTreeItem(item), item);
			assert.equal(provider.getParent(), undefined);
			assert.deepEqual(provider.getChildren(item), []);
			assert.equal(item.collapsibleState, 0);
			assert.equal(item.command, undefined);
		}
		provider.dispose();
	});

	it("serves no rows until a snapshot has been read", () => {
		const provider = new processTree.ProcessTreeProvider();
		assert.deepEqual(provider.getChildren(), []);
		provider.setSnapshot(snapshot([row({})]));
		assert.equal(provider.getChildren().length, 1);
		provider.setSnapshot(null);
		assert.deepEqual(provider.getChildren(), []);
		provider.dispose();
	});

	it("fires one change event per snapshot", () => {
		const provider = new processTree.ProcessTreeProvider();
		let fired = 0;
		provider.onDidChangeTreeData(() => {
			fired += 1;
		});
		provider.setSnapshot(snapshot([row({})]));
		assert.equal(fired, 1);
		provider.setSnapshot(null);
		assert.equal(fired, 2);
		provider.dispose();
	});

	it("disposes safely twice and stops notifying afterwards", () => {
		const provider = new processTree.ProcessTreeProvider();
		let fired = 0;
		provider.onDidChangeTreeData(() => {
			fired += 1;
		});
		provider.dispose();
		assert.doesNotThrow(() => provider.dispose());
		provider.setSnapshot(snapshot([row({})]));
		assert.equal(fired, 0);
	});
});

describe("ProcessTreeItem presentation", () => {
	it("shows an orphan under its record title with a warning and no host", () => {
		const item = itemFor({ status: "orphaned", title: "Old chat", brokerPid: 77, uptimeMs: 5000 });
		assert.equal(item.label, "Old chat");
		assert.doesNotMatch(String(item.description), /pid|77/);
		assert.deepEqual(iconOf(item), { id: "warning", color: "list.warningForeground" });
		assert.equal(item.contextValue, "ompProcess.stoppable.session.orphaned");
	});

	it("names an orphan by kind when the record has no title", () => {
		assert.equal(itemFor({ status: "orphaned" }).label, "Session process");
		assert.equal(itemFor({ status: "orphaned", kind: "terminal", ptyKind: "folder-shell" }).label, "Terminal process");
	});

	it("shows an exited child as idle", () => {
		const item = itemFor({
			kind: "terminal",
			ptyKind: "folder-shell",
			host: TERMINAL_HOST,
			window: "other-window",
			child: "exited",
			uptimeMs: 2 * 60 * 60 * 1000 + 5 * 60 * 1000,
		});
		assert.equal(item.label, "Terminal: repo");
		assert.doesNotMatch(String(item.description), /pid|4242/);
		assert.deepEqual(iconOf(item), { id: "circle-slash" });
		assert.equal(item.contextValue, "ompProcess.stoppable.terminal.idle");
	});

	it("labels a terminal by the last component of its folder, however it is spelled", () => {
		assert.equal(itemFor({ kind: "terminal", host: { ...TERMINAL_HOST, folder: "C:\\work\\repo" } }).label, "Terminal: repo");
		assert.equal(itemFor({ kind: "terminal", host: { ...TERMINAL_HOST, folder: "C:/work/other/" } }).label, "Terminal: other");
		assert.equal(itemFor({ kind: "terminal", host: { ...TERMINAL_HOST, folder: "C:\\" } }).label, "Terminal: C:\\");
	});

	it("shows an in-use session under its title with the window that holds it", () => {
		const item = itemFor({ host: SESSION_HOST, window: "this-window", drivenHere: true });
		assert.equal(item.label, "Fix the build");
		assert.doesNotMatch(String(item.description), /pid|4242/);
		assert.deepEqual(iconOf(item), { id: "comment-discussion" });
		assert.equal(item.contextValue, "ompProcess.stoppable.session.inuse");
	});

	it("shows an in-use terminal with a terminal icon", () => {
		const item = itemFor({ kind: "terminal", ptyKind: "folder-shell", host: TERMINAL_HOST, window: "other-window" });
		assert.deepEqual(iconOf(item), { id: "terminal" });
		assert.equal(item.contextValue, "ompProcess.stoppable.terminal.inuse");
	});

	it("flags a previous-build process, and an older build, and offers no stop", () => {
		const item = itemFor({
			source: "predecessor",
			status: "unknown",
			child: "unknown",
			olderBuild: true,
			stop: { available: false, reason: "Started by a previous build." },
		});
		assert.deepEqual(iconOf(item), { id: "history" });
		assert.equal(item.contextValue, "ompProcess.fixed.session.unknown");
	});

	it("shows an undecided status as unchecked", () => {
		const item = itemFor({ status: "unknown", child: "unknown", uptimeMs: null });
		assert.deepEqual(iconOf(item), { id: "question" });
		assert.equal(item.contextValue, "ompProcess.stoppable.session.unknown");
	});
});

describe("ProcessTreeItem tooltip", () => {
	it("shows user facts while keeping process identity in diagnostics", () => {
		const item = itemFor({ host: SESSION_HOST, window: "this-window" });
		const text = tooltipText(item);
		assert.equal(text.split("\n").length, 5);
		assert.ok(text.includes(SESSION_HOST.title));
		assert.ok(text.includes(new Date(BASE.startedAt).toLocaleString()));
		assert.doesNotMatch(text, /4242|host:a|broker-a|gen-1|slot|process id/i);
		const diagnostics = JSON.parse(item.diagnostics);
		assert.equal(diagnostics.brokerPid, BASE.brokerPid);
		assert.equal(diagnostics.slot, BASE.slot);
		assert.equal(diagnostics.generation, BASE.generation);
	});

	it("puts technical stop refusals behind diagnostics", () => {
		const reason = "It runs broker protocol 1 and runtime 2; End process 4242 in Task Manager.";
		const item = itemFor({ stop: { available: false, reason } });
		assert.ok(tooltipText(item).split("\n").length <= 6);
		assert.doesNotMatch(tooltipText(item), /4242|protocol|runtime/);
		assert.equal(JSON.parse(item.diagnostics).stop.reason, reason);
	});

	it("renders untrusted titles as plain text without adding tooltip lines", () => {
		const hostile = "**bold** [click](command:workbench.action.reloadWindow) <b>x</b> `code`\n# heading";
		const item = itemFor({ host: { ...SESSION_HOST, title: hostile } });
		const text = tooltipText(item);
		assert.ok(text.includes(hostile.replace("\n", " ")));
		assert.equal(text.split("\n").length, 5);
		assert.equal(item.label, hostile);
	});
});

describe("Stats process presentation", () => {
	it("has its own process kind and authenticated Stop menu context", () => {
		const item = itemFor({ kind: "stats", ptyKind: "stats-dashboard", host: { kind: "stats", window: "none" } });
		assert.equal(item.label, "Stats dashboard");
		assert.equal(item.contextValue, "ompProcess.stoppable.stats.inuse");
		assert.equal((item.iconPath as InstanceType<typeof ThemeIcon>).id, "graph");
		assert.ok(tooltipText(item).includes("Kind: Stats dashboard"));
	});
});
