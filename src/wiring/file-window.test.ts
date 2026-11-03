/**
 * The file window of Ctrl+Shift+M through its interface with fake dependencies. `vscode` is the stand-in of
 * `vscode-test-stub.ts`, so this file must run under `node --test`.
 */
import assert from "node:assert/strict";
import module from "node:module";
import { describe, it } from "node:test";

import { URI } from "vscode-uri";
import { recordingLogger } from "../shared/logger.ts";
import type { LoggedLine } from "../shared/logger.ts";
import type { StubTabGroup } from "./vscode-test-stub.ts";

// The module loads the `vscode` specifier; map it before the first import.
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
const { createFileWindow } = await import("./file-window.ts");

function fileWindowWorld() {
	const informed: string[] = [];
	const lines: LoggedLine[] = [];
	const fileWindow = createFileWindow({
		log: recordingLogger(lines),
		info: message => { informed.push(message); },
		isSessionTabInput: input => input !== null && typeof input === "object" && "session" in input,
	});
	stub.commands.calls.length = 0;
	stub.commands.handler = null;
	return { fileWindow, informed, calls: stub.commands.calls, get logged(): string[] { return lines.map(line => line.message); } };
}

describe("the file window", () => {
	const fileTab = (group: StubTabGroup, label: string) => ({ label, input: new stub.TabInputText(URI.file(`C:/work/${label}`)), group });
	const groupOf = (viewColumn: number, ...labels: string[]): StubTabGroup => {
		const group: StubTabGroup = { viewColumn, tabs: [], activeTab: undefined };
		group.tabs = labels.map(label => fileTab(group, label));
		group.activeTab = group.tabs[0];
		return group;
	};

	it("says so when no file is open next to the chat, in the log as well", async () => {
		const w = fileWindowWorld();
		const chat = { viewColumn: 1, tabs: [{ label: "chat", input: { session: true }, group: undefined as never }], activeTab: undefined } as StubTabGroup;
		stub.window.tabGroups.all = [chat];
		stub.window.tabGroups.activeTabGroup = chat;
		try {
			await w.fileWindow.toggle();
			assert.deepEqual(w.informed, ["No file is open next to the chat."]);
			assert.ok(w.logged.includes("notice: No file is open next to the chat."));
			assert.equal(w.fileWindow.column(), undefined, "no file window: VS Code chooses");
		} finally {
			stub.window.tabGroups.all = [];
		}
	});

	it("opens the files group in a window of its own through VS Code's size-taking command, keeps it on top, and remembers it", async () => {
		const w = fileWindowWorld();
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
			await w.fileWindow.toggle();
			const commands = w.calls.map(call => call[0]);
			assert.equal(commands[0], "_workbench.open");
			assert.equal((w.calls[0]?.[2] as unknown[])[0], -3, "the auxiliary window target");
			assert.ok(commands.includes("workbench.action.enableWindowAlwaysOnTop"));
			assert.equal(w.fileWindow.column(), 3, "files from the chat open in the file window while it lasts");
		} finally {
			stub.commands.handler = null;
			stub.window.tabGroups.all = [];
		}
	});

	/** Opens a file window of one file from a files group, then removes that group so only the window holds files, and returns the file window's tab through the toggle. Resolves to the command that moved the reopened file into a new group. */
	const returnedThrough = async (side: "left" | "right" | undefined, chatColumn: number, others: number[]): Promise<string | undefined> => {
		const w = fileWindowWorld();
		const chat = { viewColumn: chatColumn, tabs: [{ label: "chat", input: { session: true }, group: undefined as never }], activeTab: undefined } as StubTabGroup;
		const empties = others.map(column => groupOf(column));
		const files = groupOf(9, "a.ts");
		const auxiliary = groupOf(10);
		stub.window.tabGroups.all = [chat, ...empties, files];
		stub.window.tabGroups.activeTabGroup = files;
		if (side !== undefined) stub.workspace.settings["ompDesk.chatTabGroup"] = side;
		let moved: string | undefined;
		stub.commands.handler = (command: unknown, ...args: unknown[]) => {
			if (command === "_workbench.open") stub.window.tabGroups.all = [chat, ...empties, files, auxiliary];
			const target = args[1];
			if (command === "vscode.open" && typeof target === "object" && target !== null && "viewColumn" in target && target.viewColumn === chatColumn) chat.tabs.push(fileTab(chat, "a.ts"));
			if (command === "workbench.action.moveEditorToLeftGroup" || command === "workbench.action.moveEditorToRightGroup") {
				moved = String(command);
				stub.window.tabGroups.all = [chat, ...empties, auxiliary, groupOf(11, "a.ts")];
			}
			return undefined;
		};
		try {
			await w.fileWindow.toggle();
			auxiliary.tabs = [fileTab(auxiliary, "a.ts")];
			stub.window.tabGroups.all = [chat, ...empties, auxiliary];
			stub.window.tabGroups.activeTabGroup = chat;
			await w.fileWindow.toggle();
			return moved;
		} finally {
			stub.commands.handler = null;
			stub.window.tabGroups.all = [];
			delete stub.workspace.settings["ompDesk.chatTabGroup"];
		}
	};

	it("brings the file window's tabs back to the right of a chat group that stands alone at the left edge, the default", async () => {
		assert.equal(await returnedThrough(undefined, 1, []), "workbench.action.moveEditorToRightGroup");
	});

	it("brings them back to the left of a chat group that stands alone when the right edge is chosen", async () => {
		assert.equal(await returnedThrough("right", 1, []), "workbench.action.moveEditorToLeftGroup");
	});

	it("follows the layout over the setting: left of a chat group that is the rightmost of two, right of one with a group after it", async () => {
		assert.equal(await returnedThrough("left", 2, [1]), "workbench.action.moveEditorToLeftGroup", "chat at the right edge although the left is chosen");
		assert.equal(await returnedThrough("right", 1, [2]), "workbench.action.moveEditorToRightGroup", "chat at the left edge although the right is chosen");
	});
});
