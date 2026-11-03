import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrangeChatGroup, chatPlacement, chatSideOf, filesGroupColumn, filesSideOf, strayEmptyGroups, untilActive, type ChatLayoutApi, type ChatLayoutPanel, type LayoutGroup } from "./chat-layout.ts";

const BESIDE = -2;
const chat = { input: "chat" };
const file = { input: "file" };
const isChat = (input: unknown): boolean => input === "chat";
const group = (viewColumn: number, ...tabs: { input: unknown }[]): LayoutGroup => ({ viewColumn, tabs });

describe("the chat side", () => {
	it("is the right only for the exact value `right`, else the left, which is the default", () => {
		assert.equal(chatSideOf("right"), "right");
		for (const value of ["left", "", "Right", undefined, null, 2]) assert.equal(chatSideOf(value), "left");
	});
});

describe("chat placement", () => {
	it("joins the active group when it holds a chat, else the leftmost chat group, on either side", () => {
		const groups = [group(1, file), group(2, chat), group(3, chat, file)];
		for (const side of ["left", "right"] as const) {
			assert.deepEqual(chatPlacement(groups, 3, isChat, BESIDE, side), { column: 3, arrange: "lock" });
			assert.deepEqual(chatPlacement(groups, 1, isChat, BESIDE, side), { column: 2, arrange: "lock" });
		}
	});

	it("keeps a chat group at the left edge where it is although the right was chosen, and the reverse", () => {
		assert.deepEqual(chatPlacement([group(1, chat), group(2, file)], 2, isChat, BESIDE, "right"), { column: 1, arrange: "lock" });
		assert.deepEqual(chatPlacement([group(1, file), group(2, chat)], 1, isChat, BESIDE, "left"), { column: 2, arrange: "lock" });
	});

	it("opens a new group beside the files only when every group shows files", () => {
		assert.deepEqual(chatPlacement([group(1, file), group(2, file)], 1, isChat, BESIDE, "left"), { column: BESIDE, arrange: "move-to-side-and-lock", side: "left" });
		assert.deepEqual(chatPlacement([group(1, file), group(2, file)], 1, isChat, BESIDE, "right"), { column: BESIDE, arrange: "move-to-side-and-lock", side: "right" });
	});

	it("reuses the empty group nearest the chosen edge, such as a chat group whose last session was closed", () => {
		assert.deepEqual(chatPlacement([group(1), group(2, file), group(3)], 2, isChat, BESIDE, "left"), { column: 1, arrange: "move-to-side-and-lock", side: "left" });
		assert.deepEqual(chatPlacement([group(1), group(2, file), group(3)], 2, isChat, BESIDE, "right"), { column: 3, arrange: "move-to-side-and-lock", side: "right" });
		assert.deepEqual(chatPlacement([group(1, file), group(2)], 1, isChat, BESIDE, "left"), { column: 2, arrange: "move-to-side-and-lock", side: "left" });
		assert.deepEqual(chatPlacement([group(1)], 1, isChat, BESIDE, "right"), { column: 1, arrange: "move-to-side-and-lock", side: "right" });
	});
});

describe("the side a files group is opened on", () => {
	it("is right of a chat group that has groups to its right or only empty ones, left of the rightmost of several", () => {
		assert.equal(filesSideOf([group(1, chat), group(2, file)], 1, "left"), "right");
		assert.equal(filesSideOf([group(1, file), group(2, chat)], 2, "left"), "left", "the layout wins over the setting");
		assert.equal(filesSideOf([group(1, chat), group(2, file)], 1, "right"), "right", "a chat group at the left edge keeps its files on the right");
		assert.equal(filesSideOf([group(1, file), group(2, chat), group(3, file)], 2, "right"), "right");
	});

	it("is the side away from the chosen edge when the chat group stands alone or is not found", () => {
		assert.equal(filesSideOf([group(1, chat)], 1, "left"), "right");
		assert.equal(filesSideOf([group(1, chat)], 1, "right"), "left");
		assert.equal(filesSideOf([], null, "right"), "left");
	});
});

describe("the file group next to the chat", () => {
	it("is the active group when it holds no session, else the leftmost group of files", () => {
		const groups = [group(1, chat), group(2, file), group(3, file), group(4)];
		assert.equal(filesGroupColumn(groups, 3, isChat), 3);
		assert.equal(filesGroupColumn(groups, 1, isChat), 2);
		assert.equal(filesGroupColumn(groups, 4, isChat), 2, "an empty group has no editor to move");
	});

	it("is absent when every group with tabs holds a session", () => {
		assert.equal(filesGroupColumn([group(1, chat, file), group(2)], 1, isChat), null);
	});
});

describe("empty groups beside the chat group", () => {
	it("lists them only once a session editor exists, so the group a new session is about to use is kept", () => {
		const empty = group(2);
		assert.deepEqual(strayEmptyGroups([group(1, chat), empty, group(3, file)], isChat), [empty]);
		assert.deepEqual(strayEmptyGroups([group(1), empty, group(3, file)], isChat), []);
	});
});

const MOVE = "workbench.action.moveActiveEditorGroupLeft";
const MOVE_RIGHT = "workbench.action.moveActiveEditorGroupRight";
const LOCK = "workbench.action.lockEditorGroup";

/** A session editor VS Code has not yet reported; `report` delivers the view-state event that makes it known. */
class FakePanel implements ChatLayoutPanel {
	active = false;
	viewColumn: number | undefined = undefined;
	groupCount = 3;
	#listeners = new Set<() => void>();
	onDidChangeViewState(listener: () => void) { this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } }; }
	report(state: { active: boolean; viewColumn: number }): void { this.active = state.active; this.viewColumn = state.viewColumn; for (const listener of [...this.#listeners]) listener(); }
	get listening(): number { return this.#listeners.size; }
}

/** Records commands; moving the active group shifts the panel's column like VS Code does, and stops at the edges. */
function commands(panel: FakePanel) {
	const calls: string[] = [];
	const api: ChatLayoutApi = {
		async executeCommand(command) {
			calls.push(command);
			if (command === MOVE && panel.viewColumn !== undefined && panel.viewColumn > 1) panel.viewColumn -= 1;
			if (command === MOVE_RIGHT && panel.viewColumn !== undefined && panel.viewColumn < panel.groupCount) panel.viewColumn += 1;
		},
	};
	return { api, calls };
}

const toLeft = { column: BESIDE, arrange: "move-to-side-and-lock", side: "left" } as const;
const toRight = { column: BESIDE, arrange: "move-to-side-and-lock", side: "right" } as const;

describe("arranging the chat group", () => {
	it("waits for VS Code to report the new editor, then moves its group to the far left and locks it", async () => {
		const panel = new FakePanel();
		const { api, calls } = commands(panel);
		const arranged = arrangeChatGroup(api, toLeft, panel);
		await Promise.resolve();
		assert.deepEqual(calls, [], "nothing runs before the editor's column is known");
		panel.report({ active: true, viewColumn: 3 });
		await arranged;
		assert.equal(panel.viewColumn, 1);
		assert.deepEqual(calls, [MOVE, MOVE, LOCK]);
		assert.equal(panel.listening, 0);
	});

	it("moves a new group to the far right, as many steps as there are groups after it, and locks it", async () => {
		const panel = new FakePanel();
		panel.groupCount = 4;
		const { api, calls } = commands(panel);
		const arranged = arrangeChatGroup(api, toRight, panel);
		await Promise.resolve();
		assert.deepEqual(calls, [], "nothing runs before the editor's column is known");
		panel.report({ active: true, viewColumn: 2 });
		await arranged;
		assert.equal(panel.viewColumn, 4);
		assert.deepEqual(calls, [MOVE_RIGHT, MOVE_RIGHT, LOCK]);
		assert.equal(panel.listening, 0);
	});

	it("only locks a new group that is already at the chosen edge", async () => {
		const atRight = new FakePanel();
		atRight.report({ active: true, viewColumn: 3 });
		const right = commands(atRight);
		await arrangeChatGroup(right.api, toRight, atRight);
		assert.deepEqual(right.calls, [LOCK]);
		const atLeft = new FakePanel();
		atLeft.report({ active: true, viewColumn: 1 });
		const left = commands(atLeft);
		await arrangeChatGroup(left.api, toLeft, atLeft);
		assert.deepEqual(left.calls, [LOCK]);
	});

	it("only locks an existing chat group, wherever the user put it", async () => {
		const panel = new FakePanel();
		panel.report({ active: true, viewColumn: 2 });
		const { api, calls } = commands(panel);
		await arrangeChatGroup(api, { column: 2, arrange: "lock" }, panel);
		assert.deepEqual(calls, [LOCK]);
	});

	it("never locks when the session editor is no longer the active one", async () => {
		const panel = new FakePanel();
		panel.report({ active: true, viewColumn: 2 });
		const { calls } = commands(panel);
		const api: ChatLayoutApi = { async executeCommand(command) { calls.push(command); panel.active = false; } };
		await arrangeChatGroup(api, toLeft, panel);
		assert.deepEqual(calls, [MOVE], "the user switched to another group during the move");
	});

	it("leaves the layout alone when the editor is never reported active", async () => {
		const panel = new FakePanel();
		const { api, calls } = commands(panel);
		const arranged = arrangeChatGroup(api, toRight, panel, 10);
		panel.report({ active: false, viewColumn: 2 });
		await arranged;
		assert.deepEqual(calls, []);
		assert.equal(panel.listening, 0);
	});
});

describe("waiting for a revealed session editor", () => {
	it("resolves at once for an editor already active, and when VS Code later reports one active", async () => {
		const ready = new FakePanel();
		ready.report({ active: true, viewColumn: 1 });
		assert.equal(await untilActive(ready, 10), true);

		const revealed = new FakePanel();
		revealed.report({ active: false, viewColumn: 1 });
		const waiting = untilActive(revealed, 1000);
		revealed.report({ active: true, viewColumn: 1 });
		assert.equal(await waiting, true);
		assert.equal(revealed.listening, 0);
	});

	it("gives up with false when the editor never becomes active", async () => {
		const panel = new FakePanel();
		assert.equal(await untilActive(panel, 10), false);
		assert.equal(panel.listening, 0);
	});
});
