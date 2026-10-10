import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pinnedSessionTabId, selectionRestore, type EditorFacts } from "./session-selection.ts";

const session = (tabId: string | null): EditorFacts => ({ tabId, shell: false });
const shown = (...tabIds: string[]) => (tabId: string) => tabIds.includes(tabId);

describe("pinned session", () => {
	it("is the most recently viewed session among the open editors", () => {
		assert.equal(pinnedSessionTabId([session("tab:b"), session("tab:a")], shown("tab:a", "tab:b")), "tab:b");
	});

	it("skips folder shells, unbound editors and sessions the view does not show", () => {
		const recency: EditorFacts[] = [{ tabId: "tab:shell", shell: true }, session(null), session("tab:hidden"), session("tab:a")];
		assert.equal(pinnedSessionTabId(recency, shown("tab:shell", "tab:a")), "tab:a");
	});

	it("is nothing without an open session editor, which releases the selection", () => {
		assert.equal(pinnedSessionTabId([], shown("tab:a")), null);
		assert.equal(pinnedSessionTabId([session("tab:a")], shown()), null);
	});
});

describe("selection restore", () => {
	it("puts the pinned row back when the selection is cleared or holds only non-session rows", () => {
		assert.equal(selectionRestore("tab:a", []), "tab:a");
		assert.equal(selectionRestore("tab:a", [null]), "tab:a");
		assert.equal(selectionRestore("tab:a", [null, null]), "tab:a");
	});

	it("leaves a selection that holds a session row, the pinned one or another", () => {
		assert.equal(selectionRestore("tab:a", ["tab:a"]), null);
		assert.equal(selectionRestore("tab:a", ["tab:b"]), null);
		assert.equal(selectionRestore("tab:a", [null, "tab:b"]), null);
	});

	it("never fights when nothing is pinned", () => {
		assert.equal(selectionRestore(null, []), null);
		assert.equal(selectionRestore(null, [null]), null);
	});

	it("follows the viewed session: once another editor is viewed it is the one restored", () => {
		assert.equal(selectionRestore(pinnedSessionTabId([session("tab:b"), session("tab:a")], shown("tab:a", "tab:b")), []), "tab:b");
	});
});
