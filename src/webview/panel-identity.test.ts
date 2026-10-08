/**
 * Tests for the persisted editor identity contract.
 *
 * The regressions these defend are the two ways an editor's restart record can go
 * wrong silently. Under-persisting loses the editor: an unrecognized shape is
 * refused by the serializer, so the tab comes back as an explanation or not at
 * all. Over-persisting is worse: whatever a document writes into webview state is
 * handed back after a restart, so anything beyond the tab id — a bridge secret, a
 * host-control key — would be stored by VS Code and replayed from disk.
 *
 * Runner: `node --test src/webview/panel-identity.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PANEL_IDENTITY_META,
	PANEL_IDENTITY_VERSION,
	PANEL_IDENTITY_VERSION_EDITOR,
	PANEL_IDENTITY_VERSION_SHELL,
	SHELL_SLOT_META,
	panelDocumentIdentityBootstrapSource,
	panelIdentityFor,
	panelIdentityLiteral,
	persistedPanelEditorId,
	persistedShellSlotId,
	persistedTabId,
	shellIdentityBootstrapSource,
	shellIdentityFor,
	shellIdentityLiteral,
} from "./panel-identity.ts";

const TAB_ID = "tab:8f14e45f-ceea-4a1f-9f1e-1a2b3c4d5e6f";
/** The actual editor id (`E`) one dynamic editor's document carries. */
const EDITOR_ID = "0b1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";

describe("persistedTabId", () => {
	it("returns the tab id of the exact state this contract writes", () => {
		assert.equal(persistedTabId({ version: PANEL_IDENTITY_VERSION, tabId: TAB_ID }), TAB_ID);
		assert.equal(persistedTabId(panelIdentityFor(TAB_ID)), TAB_ID);
	});

	it("refuses any state that is not this contract's", () => {
		for (const state of [
			undefined,
			null,
			TAB_ID,
			{},
			{ version: PANEL_IDENTITY_VERSION },
			{ version: 2, tabId: TAB_ID },
			{ version: "1", tabId: TAB_ID },
			{ version: PANEL_IDENTITY_VERSION, tabId: "8f14e45f-ceea-4a1f-9f1e-1a2b3c4d5e6f" },
			{ version: PANEL_IDENTITY_VERSION, tabId: "tab:" },
			{ version: PANEL_IDENTITY_VERSION, tabId: `${TAB_ID}/../../etc` },
			{ version: PANEL_IDENTITY_VERSION, tabId: `${TAB_ID}\n` },
			{ version: PANEL_IDENTITY_VERSION, tabId: 7 },
			[PANEL_IDENTITY_VERSION, TAB_ID],
		]) {
			assert.equal(persistedTabId(state), null, `accepted ${JSON.stringify(state)}`);
		}
	});

	it("never carries a field the document did not write", () => {
		const identity = panelIdentityFor(TAB_ID);
		assert.deepEqual(identity, { version: PANEL_IDENTITY_VERSION, tabId: TAB_ID });
		assert.deepEqual(Object.keys(identity ?? {}), ["version", "tabId"]);
	});
});

describe("panelIdentityFor", () => {
	it("builds a fresh identity for a minted tab id and refuses everything else", () => {
		assert.deepEqual(panelIdentityFor(TAB_ID), { version: PANEL_IDENTITY_VERSION, tabId: TAB_ID });
		for (const value of [undefined, null, "", "tab:", 42, {}, [TAB_ID]]) {
			assert.equal(panelIdentityFor(value), null, `accepted ${JSON.stringify(value)}`);
		}
	});
});

describe("panelIdentityLiteral", () => {
	it("is the exact state, as text a document may inline", () => {
		const literal = panelIdentityLiteral(TAB_ID);
		assert.equal(literal, `{"version":${PANEL_IDENTITY_VERSION},"tabId":"${TAB_ID}"}`);
		assert.deepEqual(JSON.parse(literal ?? ""), { version: PANEL_IDENTITY_VERSION, tabId: TAB_ID });
	});

	it("refuses an id this contract does not accept", () => {
		assert.equal(panelIdentityLiteral("tab:not-a-uuid"), null);
		assert.equal(panelIdentityLiteral(undefined), null);
	});
});

describe("panelDocumentIdentityBootstrapSource", () => {
	/**
	 * Run one generated bootstrap with the globals a Webview document injects.
	 *
	 * `api` is the whole `acquireVsCodeApi` the document sees: absent, an API
	 * without `setState`, one that throws when acquired, or one that refuses the
	 * state. The generated source is the document's inline script, so it is
	 * evaluated exactly as a browser would evaluate it.
	 *
	 * @returns whether the script itself threw — a bootstrap that breaks its own
	 * document would be worse than one that persists nothing.
	 */
	function runBootstrap(source: string, api: (() => unknown) | undefined): boolean {
		Object.defineProperty(globalThis, "window", { value: { name: "webview" }, configurable: true, writable: true });
		Object.defineProperty(globalThis, "acquireVsCodeApi", { value: api, configurable: true, writable: true });
		try {
			new Function(source)();
			return false;
		} catch {
			return true;
		} finally {
			Reflect.deleteProperty(globalThis, "window");
			Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
		}
	}

	/** Run one source with a recording host API and return everything it persisted. */
	function persistedBy(source: string): unknown[] {
		const persisted: unknown[] = [];
		const threw = runBootstrap(source, () => ({ setState: (state: unknown) => persisted.push(state) }));
		assert.equal(threw, false);
		return persisted;
	}

	it("persists exactly the version-1 panel identity for the legacy static editor", () => {
		const source = panelDocumentIdentityBootstrapSource(TAB_ID, null);
		assert.notEqual(source, null);
		assert.deepEqual(persistedBy(source ?? ""), [{ version: PANEL_IDENTITY_VERSION, tabId: TAB_ID }]);
	});

	it("persists the version-2 identity, editor id included, for a dynamic editor", () => {
		const source = panelDocumentIdentityBootstrapSource(TAB_ID, EDITOR_ID);
		assert.notEqual(source, null);
		// The exact state the dynamic serializer reads back: a version-1 state here would
		// leave the editor unidentifiable at its next restart.
		assert.deepEqual(persistedBy(source ?? ""), [{ version: PANEL_IDENTITY_VERSION_EDITOR, tabId: TAB_ID, editorId: EDITOR_ID }]);
	});

	it("persists nothing, and throws nothing, when the document has no usable host API", () => {
		const source = panelDocumentIdentityBootstrapSource(TAB_ID, EDITOR_ID) ?? "";
		// No injected factory at all, then an API without `setState`, then a factory
		// that throws. A host that refuses the state afterwards has nothing to record.
		assert.equal(runBootstrap(source, undefined), false);
		assert.equal(runBootstrap(source, () => ({ postMessage: () => {} })), false);
		assert.equal(
			runBootstrap(source, () => {
				throw new Error("the injected API is not callable here");
			}),
			false,
		);
		assert.equal(
			runBootstrap(source, () => ({
				setState: () => {
					throw new Error("the host refused the state");
				},
			})),
			false,
		);
	});

	it("refuses to generate a bootstrap for an id this contract does not accept", () => {
		for (const tabId of ["not-a-tab-id", undefined, null, 7, {}]) {
			assert.equal(panelDocumentIdentityBootstrapSource(tabId, null), null, `accepted ${JSON.stringify(tabId)}`);
			assert.equal(panelDocumentIdentityBootstrapSource(tabId, EDITOR_ID), null, `accepted ${JSON.stringify(tabId)}`);
		}
		// An editor id that is not this contract's shape refuses the version-2 identity
		// rather than quietly persisting the weaker version-1 one for a dynamic editor.
		for (const editorId of ["", "not-an-editor-id", EDITOR_ID.toUpperCase(), 7, undefined, TAB_ID]) {
			assert.equal(
				panelDocumentIdentityBootstrapSource(TAB_ID, editorId),
				null,
				`accepted ${JSON.stringify(editorId)}`,
			);
		}
	});

	it("names the meta tag the guest bootstrap reads its identity from", () => {
		assert.equal(PANEL_IDENTITY_META, "omp-tab-id");
	});
});

/**
 * A folder shell has no launcher tab and no session, so it persists its slot and
 * nothing else. The regression is a cross-kind one: a shell state read as a chat
 * identity (or the reverse) would make the extension host resolve an editor it does
 * not own, so each reader refuses the other kind's version outright.
 */
const SHELL_SLOT = "shell:1f0c9b3a-2f4e-4c7a-8d31-9a5b6c7d8e9f";

describe("folder shell identity", () => {
	it("round-trips the slot id through the state the document persists", () => {
		assert.deepEqual(shellIdentityFor(SHELL_SLOT), { version: PANEL_IDENTITY_VERSION_SHELL, slotId: SHELL_SLOT });
		assert.equal(persistedShellSlotId(shellIdentityFor(SHELL_SLOT)), SHELL_SLOT);
	});

	it("refuses a slot id that is not the grammar the host mints", () => {
		for (const refused of [undefined, null, "", "shell:", "shell:not-a-uuid", `shell:${SHELL_SLOT}`, 7, {}]) {
			assert.equal(shellIdentityFor(refused), null, `accepted ${String(refused)}`);
			assert.equal(persistedShellSlotId({ version: PANEL_IDENTITY_VERSION_SHELL, slotId: refused }), null, `accepted ${String(refused)}`);
		}
	});

	it("refuses the other kind's state instead of reading a field that is not there", () => {
		for (const state of [
			undefined,
			null,
			{ version: PANEL_IDENTITY_VERSION, tabId: TAB_ID },
			{ version: PANEL_IDENTITY_VERSION_EDITOR, tabId: TAB_ID, editorId: "0".repeat(32) },
			{ version: PANEL_IDENTITY_VERSION_SHELL },
			{ version: PANEL_IDENTITY_VERSION_SHELL, slotId: TAB_ID },
			{ version: "3", slotId: SHELL_SLOT },
		]) {
			assert.equal(persistedShellSlotId(state), null, `accepted ${JSON.stringify(state)}`);
		}
		assert.equal(persistedTabId({ version: PANEL_IDENTITY_VERSION_SHELL, slotId: SHELL_SLOT }), null);
		assert.equal(persistedPanelEditorId({ version: PANEL_IDENTITY_VERSION_SHELL, slotId: SHELL_SLOT }), null);
	});

	it("carries exactly the version and the slot, and nothing else", () => {
		const identity = shellIdentityFor(SHELL_SLOT);
		assert.deepEqual(Object.keys(identity ?? {}), ["version", "slotId"]);
		assert.equal(shellIdentityLiteral(SHELL_SLOT), `{"version":${PANEL_IDENTITY_VERSION_SHELL},"slotId":"${SHELL_SLOT}"}`);
	});

	it("generates a bootstrap that persists the shell identity through the injected API", () => {
		const persisted: unknown[] = [];
		const source = shellIdentityBootstrapSource(SHELL_SLOT);
		assert.notEqual(source, null);
		Object.defineProperty(globalThis, "window", { value: { name: "webview" }, configurable: true, writable: true });
		Object.defineProperty(globalThis, "acquireVsCodeApi", {
			value: () => ({ setState: (state: unknown) => persisted.push(state) }),
			configurable: true,
			writable: true,
		});
		try {
			new Function(source ?? "")();
		} finally {
			Reflect.deleteProperty(globalThis, "window");
			Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
		}
		assert.deepEqual(persisted, [{ version: PANEL_IDENTITY_VERSION_SHELL, slotId: SHELL_SLOT }]);
	});

	it("generates nothing for a slot id this contract refuses, and names its meta tag", () => {
		assert.equal(shellIdentityBootstrapSource("shell:nope"), null);
		assert.equal(shellIdentityLiteral(undefined), null);
		assert.equal(SHELL_SLOT_META, "omp-shell-slot");
	});
});
