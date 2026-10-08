/**
 * The editor-slot registry: one controller per conversation, many passive readers.
 *
 * Runner: `node --test src/host/editor-slots.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEditorSlotRegistry, isEditorSlotId } from "./editor-slots.ts";

describe("editor slot ids", () => {
	it("accepts an opaque editor identity and refuses anything unusable", () => {
		assert.equal(isEditorSlotId("3f9a2c1b4d5e6f708192a3b4c5d6e7f8"), true);
		for (const bad of ["", `${"a".repeat(129)}`, "has space", "has/slash", null, 7]) {
			assert.equal(isEditorSlotId(bad), false, `accepted ${String(bad)}`);
		}
	});
});

describe("editor slot registry", () => {
	it("keys every slot by its own immutable id, never by the conversation", () => {
		const registry = createEditorSlotRegistry();
		registry.register({ slotId: "editor-a", tabId: "tab:x", role: "controlling" });
		registry.register({ slotId: "editor-b", tabId: "tab:x", role: "passive", passiveReason: "read-only" });
		assert.deepEqual(registry.slotsFor("tab:x").map(entry => entry.slotId), ["editor-a", "editor-b"]);
		assert.equal(registry.get("editor-b")?.passiveReason, "read-only");
		assert.equal(registry.controllerOf("tab:x")?.slotId, "editor-a");
		assert.equal(registry.isCoherent("tab:x"), true);
	});

	it("demotes a rival controller instead of dropping it, and bumps its generation", () => {
		const registry = createEditorSlotRegistry();
		const first = registry.register({ slotId: "editor-a", tabId: "tab:x", role: "controlling" });
		assert.equal(first.generation, 1);
		const second = registry.register({ slotId: "editor-b", tabId: "tab:x", role: "controlling" });
		assert.equal(second.generation, 1);
		// The earlier controller is demoted, keeping its entry and its own identity.
		const demoted = registry.get("editor-a");
		assert.equal(demoted?.role, "passive");
		assert.equal(demoted?.generation, 2, "a role change must advance the generation");
		assert.match(String(demoted?.passiveReason), /became the controller/);
		assert.equal(registry.controllerOf("tab:x")?.slotId, "editor-b");
		assert.equal(registry.get("editor-a")?.slotId, "editor-a");
	});

	it("advances the generation only when the binding or the role really changed", () => {
		const registry = createEditorSlotRegistry();
		registry.register({ slotId: "editor-a", tabId: "tab:x", role: "controlling" });
		const same = registry.register({ slotId: "editor-a", tabId: "tab:x", role: "controlling" });
		assert.equal(same.generation, 1, "a re-report must not invalidate a correct page's credentials");
		const moved = registry.register({ slotId: "editor-a", tabId: "tab:y", role: "controlling" });
		assert.equal(moved.generation, 2, "a conversation change must advance the generation");
		const demoted = registry.register({ slotId: "editor-a", tabId: "tab:y", role: "passive" });
		assert.equal(demoted.generation, 3);
		assert.equal(demoted.passiveReason !== null, true);
	});

	it("reports incoherence while two slots claim the same conversation", () => {
		const registry = createEditorSlotRegistry();
		registry.register({ slotId: "editor-a", tabId: "tab:x", role: "controlling" });
		registry.register({ slotId: "editor-b", tabId: "tab:x", role: "controlling" });
		// Registration always resolves the election, so coherence holds afterwards.
		assert.equal(registry.isCoherent("tab:x"), true);
		assert.equal(registry.slotsFor("tab:x").filter(entry => entry.role === "controlling").length, 1);
		// A conversation with only a passive slot has no controller at all.
		registry.register({ slotId: "editor-c", tabId: "tab:z", role: "passive" });
		assert.equal(registry.isCoherent("tab:z"), false);
		assert.equal(registry.controllerOf("tab:z"), null);
	});

	it("keeps two passive panels of one conversation distinct, and closing one leaves the other", () => {
		const registry = createEditorSlotRegistry();
		// The controller plus two passive readers of one conversation: three distinct
		// immutable slots, three distinct entries, no collision and no shared key.
		registry.register({ slotId: "editor-controller", tabId: "tab:x", role: "controlling" });
		registry.register({ slotId: "editor-stop-1", tabId: "tab:x", role: "passive", passiveReason: "not controlling" });
		registry.register({ slotId: "editor-stop-2", tabId: "tab:x", role: "passive", passiveReason: "not controlling" });
		assert.deepEqual(
			registry.slotsFor("tab:x").map(entry => entry.slotId),
			["editor-controller", "editor-stop-1", "editor-stop-2"],
			"the controlling slot comes first and every passive slot keeps its own identity",
		);
		assert.equal(registry.controllerOf("tab:x")?.slotId, "editor-controller");

		assert.equal(registry.remove("editor-stop-1"), true);
		assert.equal(registry.get("editor-stop-1"), null);
		assert.equal(registry.get("editor-stop-2")?.role, "passive");
		assert.equal(registry.controllerOf("tab:x")?.slotId, "editor-controller");
		assert.equal(registry.isCoherent("tab:x"), true);
	});

	it("drops a slot without disturbing the others", () => {
		const registry = createEditorSlotRegistry();
		registry.register({ slotId: "editor-a", tabId: "tab:x", role: "controlling" });
		registry.register({ slotId: "editor-b", tabId: "tab:x", role: "passive" });
		assert.equal(registry.remove("editor-b"), true);
		assert.equal(registry.remove("editor-b"), false);
		assert.equal(registry.controllerOf("tab:x")?.slotId, "editor-a");
		assert.equal(registry.get("editor-b"), null);
	});
});
