/**
 * Editor/document identity, viewType round-tripping and the workspace hash.
 *
 * The `mainThreadWebview-` spelling is not invented here: VS Code 1.139.1 reports
 * exactly that prefix in `TabInputWebview.viewType` for a registered external
 * type, and the installed workbench bundle uses precisely that string.
 *
 * Runner: `node --test src/bridge-identity.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BRIDGE_VIEW_TYPE_NAMESPACE,
	LEGACY_VIEW_TYPE,
	bridgePanelState,
	bridgeViewType,
	decodeBridgeViewType,
	externalBridgeViewType,
	isBridgeTabId,
	persistedBridgeState,
	recoveredBridgePanelState,
	tabIdFromToken,
	tabIdToken,
	tabInputIdentity,
	workspaceIdentityText,
} from "./bridge-identity.ts";

const TAB = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR = "0b4d36ccc94648ed07827fcf238c42dc";
const OTHER_EDITOR = "7c9a67255f727ecb87e5351a63a07499";

describe("bridge view types", () => {
	it("round-trips one editor of one tab", () => {
		const type = bridgeViewType(TAB, EDITOR);
		assert.equal(type, `${BRIDGE_VIEW_TYPE_NAMESPACE}2.11111111222233334444555555555555.${EDITOR}`);
		assert.deepEqual(decodeBridgeViewType(type), { tabId: TAB, editorIdHex: EDITOR });
		assert.equal(tabIdFromToken(tabIdToken(TAB)), TAB);
	});

	it("refuses anything that is not exactly one of ours", () => {
		for (const bad of [
			LEGACY_VIEW_TYPE,
			`${BRIDGE_VIEW_TYPE_NAMESPACE}1.11111111222233334444555555555555.${EDITOR}`,
			`${BRIDGE_VIEW_TYPE_NAMESPACE}2.11111111222233334444555555555555`,
			`${BRIDGE_VIEW_TYPE_NAMESPACE}2.11111111222233334444555555555555.${EDITOR}.extra`,
			`${BRIDGE_VIEW_TYPE_NAMESPACE}2.1111111122223333444455555555555Z.${EDITOR}`,
			`${BRIDGE_VIEW_TYPE_NAMESPACE}2.11111111222233334444555555555555.${EDITOR.toUpperCase()}`,
			"omp.session.b2.notatoken.notatoken",
			null,
			7,
		]) {
			assert.equal(decodeBridgeViewType(bad), null);
		}
	});

	it("strips the installed tab-input prefix, and refuses a foreign one", () => {
		const type = bridgeViewType(TAB, EDITOR);
		assert.equal(externalBridgeViewType(`mainThreadWebview-${type}`), type);
		assert.equal(externalBridgeViewType(type), type, "an in-process type arrives unprefixed");
		assert.equal(externalBridgeViewType("mainThreadWebview-simpleBrowser.view"), null);
		assert.equal(externalBridgeViewType(`mainThreadWebview-${LEGACY_VIEW_TYPE}`), null);
		assert.equal(externalBridgeViewType(undefined), null);
		assert.deepEqual(tabInputIdentity(`mainThreadWebview-${type}`), { tabId: TAB, editorIdHex: EDITOR });
		assert.deepEqual(tabInputIdentity(type), { tabId: TAB, editorIdHex: EDITOR });
	});
});

describe("tab ids and persisted state", () => {
	it("requires the canonical tab id spelling", () => {
		assert.equal(isBridgeTabId(TAB), true);
		assert.equal(isBridgeTabId(TAB.toUpperCase()), false);
		assert.equal(isBridgeTabId("tab:11111111222233334444555555555555"), false);
		assert.equal(isBridgeTabId(`${TAB}x`), false);
		assert.equal(isBridgeTabId(null), false);
	});

	it("persists identity only, version 2", () => {
		const state = bridgePanelState(TAB, EDITOR);
		assert.deepEqual(state, { version: 2, tabId: TAB, editorId: EDITOR });
		assert.deepEqual(persistedBridgeState(state), state);
		assert.equal(persistedBridgeState({ version: 1, tabId: TAB }), null, "the legacy identity is not this one");
		assert.deepEqual(persistedBridgeState({ version: 2, tabId: TAB, editorId: EDITOR, link: "wss://x" }), state, "extra fields are ignored, not merged into authority");
		assert.equal(persistedBridgeState({ version: 2, tabId: TAB, editorId: EDITOR.toUpperCase() }), null);
		assert.equal(persistedBridgeState({ version: 2, tabId: TAB }), null);
		assert.throws(() => bridgePanelState("tab:nope", EDITOR), TypeError);
		assert.throws(() => bridgePanelState(TAB, "short"), TypeError);
	});
});

describe("legacy version-1 recovery", () => {
	const OTHER_TAB = "tab:99999999-8888-7777-6666-555555555555";
	const legacyState = { version: 1, tabId: TAB };
	const controlling = { tabId: TAB, role: "controlling" };
	/** A lookup that answers only for one editor, and records what it was asked. */
	function bindingOf(answer: { readonly tabId: string; readonly role: string } | null, asked: string[] = []) {
		return {
			asked,
			lookup: (editorIdHex: string) => {
				asked.push(editorIdHex);
				return editorIdHex === EDITOR ? answer : null;
			},
		};
	}

	it("recovers the editor id from the view type when the durable binding proves it", () => {
		const lookup = bindingOf(controlling);
		const recovered = recoveredBridgePanelState(bridgeViewType(TAB, EDITOR), legacyState, lookup.lookup);
		assert.deepEqual(recovered, { version: 2, tabId: TAB, editorId: EDITOR });
		assert.deepEqual(lookup.asked, [EDITOR], "the binding is asked about the editor the view type names");
		// The recovered state is exactly what a document of this editor persists, so the
		// editor's next restart reads it back as its own revival.
		assert.deepEqual(persistedBridgeState(recovered), recovered);
	});

	it("matches tab spellings the way the version-2 guard does", () => {
		const recovered = recoveredBridgePanelState(
			bridgeViewType(TAB, EDITOR),
			{ version: 1, tabId: TAB.toUpperCase() },
			bindingOf(controlling).lookup,
		);
		assert.deepEqual(recovered, { version: 2, tabId: TAB, editorId: EDITOR });
	});

	it("refuses a version-1 state whose tab is not the one the view type names", () => {
		assert.equal(
			recoveredBridgePanelState(bridgeViewType(TAB, EDITOR), legacyState, bindingOf({ tabId: OTHER_TAB, role: "controlling" }).lookup),
			null,
			"a controlling binding of another conversation must not adopt this editor",
		);
		assert.equal(
			recoveredBridgePanelState(bridgeViewType(OTHER_TAB, EDITOR), legacyState, bindingOf(controlling).lookup),
			null,
			"the saved tab and the view type must name the same tab",
		);
	});

	it("refuses the state when no durable binding proves the editor controls that tab", () => {
		const type = bridgeViewType(TAB, EDITOR);
		// Absent, passive, or a role that is not the committed controller: each is a
		// conversation that already has (or may have) another writer, so this editor is
		// not adopted. An absent binding is also how an editor whose binding belongs to
		// *another* editor is seen — the lookup is asked about this view type's editor.
		assert.equal(recoveredBridgePanelState(type, legacyState, bindingOf(null).lookup), null);
		assert.equal(recoveredBridgePanelState(type, legacyState, bindingOf({ tabId: TAB, role: "passive" }).lookup), null);
		assert.equal(recoveredBridgePanelState(type, legacyState, bindingOf({ tabId: TAB, role: "unknown" }).lookup), null);
	});

	it("refuses anything that is not a version-1 state on a recognized type", () => {
		const lookup = bindingOf(controlling).lookup;
		const type = bridgeViewType(TAB, EDITOR);
		for (const state of [
			undefined,
			null,
			TAB,
			{},
			{ version: 1 },
			{ version: 1, tabId: "not-a-tab-id" },
			{ version: "1", tabId: TAB },
			{ version: 3, tabId: TAB },
			{ version: 2, tabId: TAB, editorId: OTHER_EDITOR },
		]) {
			assert.equal(recoveredBridgePanelState(type, state, lookup), null, `accepted ${JSON.stringify(state)}`);
		}
		for (const viewType of [LEGACY_VIEW_TYPE, `${BRIDGE_VIEW_TYPE_NAMESPACE}2.${EDITOR}.${EDITOR}`, "omp.session.b3.a.b", undefined, 7]) {
			assert.equal(recoveredBridgePanelState(viewType, legacyState, lookup), null, `accepted type ${String(viewType)}`);
		}
	});
});

describe("workspace identity text", () => {
	it("is stable across ordering and path spellings, and separates workspaces", () => {
		const first = workspaceIdentityText(["D:\\work\\a", "D:/work/b"], null);
		const reordered = workspaceIdentityText(["D:/work/b", "D:\\work\\a"], null);
		assert.equal(first, reordered);
		assert.equal(first, "folders:D:/work/a|D:/work/b");
		assert.notEqual(workspaceIdentityText(["D:/work/a"], null), first);
		assert.equal(workspaceIdentityText([], "D:/work/one.code-workspace"), "file:D:/work/one.code-workspace");
		assert.notEqual(workspaceIdentityText(["D:/work/a"], "D:/w.code-workspace"), first);
	});
});
