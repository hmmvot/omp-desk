import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrangeChatGroup, chatPlacement, filesGroupColumn, strayEmptyGroups, untilActive, type ChatLayoutApi, type ChatLayoutPanel, type LayoutGroup } from "./chat-layout.ts";

const BESIDE = -2;
const chat = { input: "chat" };
const file = { input: "file" };
const isChat = (input: unknown): boolean => input === "chat";
const group = (viewColumn: number, ...tabs: { input: unknown }[]): LayoutGroup => ({ viewColumn, tabs });

describe("chat placement", () => {
	it("joins the active group when it holds a chat, else the leftmost chat group", () => {
		const groups = [group(1, file), group(2, chat), group(3, chat, file)];
		assert.deepEqual(chatPlacement(groups, 3, isChat, BESIDE), { column: 3, arrange: "lock" });
		assert.deepEqual(chatPlacement(groups, 1, isChat, BESIDE), { column: 2, arrange: "lock" });
	});

	it("opens a new group beside the files only when every group shows files", () => {
		assert.deepEqual(chatPlacement([group(1, file), group(2, file)], 1, isChat, BESIDE), { column: BESIDE, arrange: "move-left-and-lock" });
	});

	it("reuses the leftmost empty group, such as a chat group whose last session was closed", () => {
		assert.deepEqual(chatPlacement([group(1), group(2, file), group(3)], 2, isChat, BESIDE), { column: 1, arrange: "move-left-and-lock" });
		assert.deepEqual(chatPlacement([group(1, file), group(2)], 1, isChat, BESIDE), { column: 2, arrange: "move-left-and-lock" });
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
const LOCK = "workbench.action.lockEditorGroup";

/** A session editor VS Code has not yet reported; `report` delivers the view-state event that makes it known. */
class FakePanel implements ChatLayoutPanel {
	active = false;
	viewColumn: number | undefined = undefined;
	#listeners = new Set<() => void>();
	onDidChangeViewState(listener: () => void) { this.#listeners.add(listener); return { dispose: () => { this.#listeners.delete(listener); } }; }
	report(state: { active: boolean; viewColumn: number }): void { this.active = state.active; this.viewColumn = state.viewColumn; for (const listener of [...this.#listeners]) listener(); }
	get listening(): number { return this.#listeners.size; }
}

/** Records commands; moving the active group left shifts the panel's column like VS Code does. */
function commands(panel: FakePanel) {
	const calls: string[] = [];
	const api: ChatLayoutApi = {
		async executeCommand(command) {
			calls.push(command);
			if (command === MOVE && panel.viewColumn !== undefined && panel.viewColumn > 1) panel.viewColumn -= 1;
		},
	};
	return { api, calls };
}

describe("arranging the chat group", () => {
	it("waits for VS Code to report the new editor, then moves its group to the far left and locks it", async () => {
		const panel = new FakePanel();
		const { api, calls } = commands(panel);
		const arranged = arrangeChatGroup(api, { column: BESIDE, arrange: "move-left-and-lock" }, panel);
		await Promise.resolve();
		assert.deepEqual(calls, [], "nothing runs before the editor's column is known");
		panel.report({ active: true, viewColumn: 3 });
		await arranged;
		assert.equal(panel.viewColumn, 1);
		assert.deepEqual(calls, [MOVE, MOVE, LOCK]);
		assert.equal(panel.listening, 0);
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
		await arrangeChatGroup(api, { column: BESIDE, arrange: "move-left-and-lock" }, panel);
		assert.deepEqual(calls, [MOVE], "the user switched to another group during the move");
	});

	it("leaves the layout alone when the editor is never reported active", async () => {
		const panel = new FakePanel();
		const { api, calls } = commands(panel);
		const arranged = arrangeChatGroup(api, { column: BESIDE, arrange: "move-left-and-lock" }, panel, 10);
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
