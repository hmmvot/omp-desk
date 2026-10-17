import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectEditorTab, TAB_SELECT_ATTEMPTS, TAB_SELECT_WAIT_MS } from "./editor-tab-selection.ts";
import type { SelectableTab, TabSelectionApi } from "./editor-tab-selection.ts";

const SLOT = "e".repeat(32);
const FOCUS = ["focus-1", "focus-2", "focus-3"];

interface FakeTab extends SelectableTab {
	isActive: boolean;
	group: { viewColumn: number; tabs: unknown[] };
}

/**
 * VS Code's tab API on a virtual clock: a command resolves at once, and whatever it makes happen
 * (an activation, a group focus) is scheduled for later and delivered as a tab change.
 */
function fakeVscode(options: { columns?: number; activeColumn?: number; tabColumn?: number; tabIndex?: number } = {}) {
	const columns = options.columns ?? 2;
	const tabColumn = options.tabColumn ?? 2;
	const groups = Array.from({ length: columns }, (_, at) => ({ viewColumn: at + 1, tabs: [] as unknown[] }));
	const tab: FakeTab = { isActive: false, group: groups[tabColumn - 1]! };
	const before = options.tabIndex ?? 1;
	for (let at = 0; at < before; at++) tab.group.tabs.push({});
	tab.group.tabs.push(tab);
	const state = {
		now: 0,
		activeColumn: options.activeColumn ?? 1,
		tab: tab as FakeTab | null,
		commands: [] as unknown[][],
		infos: [] as string[],
		scheduled: [] as { at: number; run(): void }[],
		/** What a command does: the test's model of VS Code. */
		onCommand: (_command: string, ..._args: unknown[]): void => {},
		waits: 0,
	};
	const api: TabSelectionApi = {
		tabOf: () => state.tab,
		activeColumn: () => state.activeColumn,
		executeCommand: async (command, ...args) => { state.commands.push([command, ...args]); state.onCommand(command, ...args); },
		nextTabChange: async ms => {
			state.waits++;
			const due = state.scheduled.filter(event => event.at <= state.now + ms).sort((a, b) => a.at - b.at)[0];
			if (due === undefined) { state.now += ms; return; }
			state.scheduled.splice(state.scheduled.indexOf(due), 1);
			state.now = Math.max(state.now, due.at);
			due.run();
		},
		now: () => state.now,
		info: message => { state.infos.push(message); },
	};
	const activateLater = (afterMs: number): void => {
		state.scheduled.push({ at: state.now + afterMs, run: () => { tab.isActive = true; } });
	};
	return { state, api, tab, activateLater };
}

describe("selecting a restored editor's tab", () => {
	it("waits for the activation VS Code reports after the command resolved", async () => {
		const world = fakeVscode({ tabColumn: 1, activeColumn: 1 });
		world.state.onCommand = command => { if (command === "workbench.action.openEditorAtIndex") world.activateLater(300); };
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), true);
		assert.deepEqual(world.state.commands, [["workbench.action.openEditorAtIndex", 1]], "the command is not repeated while the open is in flight");
		assert.deepEqual(world.state.infos, []);
	});

	it("focuses the group first and selects by position", async () => {
		const world = fakeVscode({ tabColumn: 2, activeColumn: 1, tabIndex: 3 });
		world.state.onCommand = command => { if (command === "workbench.action.openEditorAtIndex") world.activateLater(0); };
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), true);
		assert.deepEqual(world.state.commands, [["focus-2"], ["workbench.action.openEditorAtIndex", 3]]);
	});

	it("does nothing for a tab that is already the active one of the focused group", async () => {
		const world = fakeVscode({ tabColumn: 1, activeColumn: 1 });
		world.tab.isActive = true;
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), true);
		assert.deepEqual(world.state.commands, []);
	});

	it("issues the command again when VS Code swallowed the first one, and reports success once it takes", async () => {
		const world = fakeVscode({ tabColumn: 1, activeColumn: 1 });
		let issued = 0;
		world.state.onCommand = command => { if (command === "workbench.action.openEditorAtIndex" && ++issued === 2) world.activateLater(10); };
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), true);
		assert.equal(issued, 2);
		assert.equal(world.state.infos.length, 1);
		assert.match(world.state.infos[0]!, /not active 2000 ms after openEditorAtIndex; issuing it again/);
	});

	it("logs why it gave up when the tab never becomes active", async () => {
		const world = fakeVscode({ tabColumn: 1, activeColumn: 1 });
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), false);
		assert.equal(world.state.commands.length, TAB_SELECT_ATTEMPTS);
		assert.equal(world.state.now, TAB_SELECT_WAIT_MS * TAB_SELECT_ATTEMPTS, "the wait is bounded");
		assert.match(world.state.infos.at(-1)!, /^editor eeeeeeee: not selected, its tab in group 1 was not active 2000 ms after each of 2 openEditorAtIndex commands$/);
	});

	it("logs that VS Code has no tab for the editor", async () => {
		const world = fakeVscode();
		world.state.tab = null;
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), false);
		assert.deepEqual(world.state.commands, []);
		assert.deepEqual(world.state.infos, ["editor eeeeeeee: not selected, VS Code has no tab for it"]);
	});

	it("logs that the tab closed while it was being selected", async () => {
		const world = fakeVscode({ tabColumn: 1, activeColumn: 1 });
		world.state.onCommand = () => { world.state.tab = null; };
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), false);
		assert.equal(world.state.commands.length, 1);
		assert.deepEqual(world.state.infos, ["editor eeeeeeee: not selected, its tab closed while it was being selected"]);
	});

	it("reaches a group past the last one with a focus command by stepping from the focused group", async () => {
		const world = fakeVscode({ columns: 5, tabColumn: 5, activeColumn: 2 });
		world.state.onCommand = command => { if (command === "workbench.action.openEditorAtIndex") world.activateLater(0); };
		assert.equal(await selectEditorTab(world.api, SLOT, FOCUS), true);
		assert.deepEqual(world.state.commands, [
			["workbench.action.focusNextGroup"],
			["workbench.action.focusNextGroup"],
			["workbench.action.focusNextGroup"],
			["workbench.action.openEditorAtIndex", 1],
		]);
	});

	it("steps backwards to a group left of the focused one when it has no focus command", async () => {
		const world = fakeVscode({ columns: 5, tabColumn: 4, activeColumn: 5 });
		world.state.onCommand = command => { if (command === "workbench.action.openEditorAtIndex") world.activateLater(0); };
		assert.equal(await selectEditorTab(world.api, SLOT, ["focus-1"]), true);
		assert.deepEqual(world.state.commands[0], ["workbench.action.focusPreviousGroup"]);
		assert.equal(world.state.commands.length, 2);
	});
});
