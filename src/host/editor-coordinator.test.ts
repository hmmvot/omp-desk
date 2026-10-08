/**
 * The one-winner reservation table of this window's editors.
 *
 * The cases defended here: a saved editor wins over a transient panel an explicit
 * open created; a second saved callback for the *same* tab loses; the callback for
 * the *same* editor id joins its own reservation (that is a reload, not a duplicate);
 * only the winner can be released by a close, and only one legacy migration may run
 * per tab.
 *
 * Runner: `node --test src/host/editor-coordinator.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorCoordinator } from "./editor-coordinator.ts";

const TAB = "tab:11111111-2222-3333-4444-555555555555";
const EDITOR_A = "a".repeat(32);
const EDITOR_B = "b".repeat(32);

describe("editor reservations", () => {
	it("lets the first candidate win and a later different editor lose", () => {
		const editors = new EditorCoordinator();
		assert.equal(editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "saved", sequence: 4 }).outcome, "won");
		const second = editors.reserve({ tabId: TAB, editorId: EDITOR_B, provenance: "saved", sequence: 5 });
		assert.equal(second.outcome, "lost");
		assert.equal(second.reservation.editorId, EDITOR_A, "the loser is told which editor actually holds the tab");
		assert.equal(editors.holds(TAB, EDITOR_A), true);
		assert.equal(editors.holds(TAB, EDITOR_B), false);
	});

	it("joins the reservation of the same editor instead of refusing it", () => {
		const editors = new EditorCoordinator();
		editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "saved", sequence: 1 });
		editors.noteDocument(TAB, EDITOR_A, "d".repeat(32));
		const again = editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "saved", sequence: 9 });
		assert.equal(again.outcome, "joined");
		assert.equal(again.reservation.documentId, "d".repeat(32), "joining keeps what is already known about the editor");
		assert.equal(again.reservation.sequence, 1, "the original observation stands");
	});

	it("replaces a transient editor with the saved one and retires its transition", () => {
		const editors = new EditorCoordinator();
		editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "transient", sequence: 1 });
		const ticket = editors.claimTransition(TAB, EDITOR_A);
		assert.notEqual(ticket, null);
		const restored = editors.reserve({ tabId: TAB, editorId: EDITOR_B, provenance: "saved", sequence: 2 });
		assert.equal(restored.outcome, "replaced");
		assert.equal(editors.transitionHolds(TAB, EDITOR_A, ticket ?? 0), false, "the retired editor's migration no longer holds");
		// A saved editor is not replaced by a transient one.
		const created = editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "transient", sequence: 3 });
		assert.equal(created.outcome, "lost");
	});

	it("releases only the winner, and only once", () => {
		const editors = new EditorCoordinator();
		editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "saved", sequence: 1 });
		editors.release(TAB, EDITOR_B);
		assert.equal(editors.holds(TAB, EDITOR_A), true, "a losing editor's close must not free the tab");
		editors.release(TAB, EDITOR_A);
		assert.equal(editors.winner(TAB), null);
		// With the winner gone the next candidate can win.
		assert.equal(editors.reserve({ tabId: TAB, editorId: EDITOR_B, provenance: "saved", sequence: 2 }).outcome, "won");
	});

	it("allows exactly one legacy migration per tab", () => {
		const editors = new EditorCoordinator();
		editors.reserve({ tabId: TAB, editorId: EDITOR_A, provenance: "saved", sequence: 1 });
		const ticket = editors.claimTransition(TAB, EDITOR_A);
		assert.notEqual(ticket, null);
		assert.equal(editors.claimTransition(TAB, EDITOR_A), null, "a second migration of one tab is refused");
		assert.equal(editors.transitionHolds(TAB, EDITOR_A, ticket ?? 0), true);
		assert.equal(editors.transitionHolds(TAB, EDITOR_A, (ticket ?? 0) + 1), false);
		editors.settleTransition(TAB, EDITOR_A, ticket ?? 0);
		assert.equal(editors.transitionHolds(TAB, EDITOR_A, ticket ?? 0), false);
		assert.notEqual(editors.claimTransition(TAB, EDITOR_A), null, "after the migration settles the tab can migrate again");
	});

	it("refuses a tab id that is not the canonical spelling", () => {
		const editors = new EditorCoordinator();
		assert.throws(() => editors.reserve({ tabId: "tab:not-a-uuid", editorId: EDITOR_A, provenance: "saved", sequence: 1 }), TypeError);
	});
});
