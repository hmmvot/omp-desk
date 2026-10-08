/**
 * The durable broker slot table: capacity is a refusal, never an eviction.
 *
 * Runner: `node --test src/host/broker-slots.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BROKER_SLOT_LIMIT, createBrokerSlotStore, createHostSlotId, isHostSlotId } from "./broker-slots.ts";
import type { BrokerMemento } from "./broker-slots.ts";

function memento(initial: unknown = null): BrokerMemento & { readonly writes: readonly unknown[] } {
	const writes: unknown[] = [];
	let value = initial;
	return {
		writes,
		get: (_key, fallback) => value ?? fallback,
		update: (_key, next) => {
			value = next;
			writes.push(next);
			return Promise.resolve();
		},
	};
}

describe("broker slot ids", () => {
	it("mints the exact shape the table accepts", () => {
		const slot = createHostSlotId();
		assert.equal(isHostSlotId(slot), true);
		for (const bad of ["", "tab:one", "host:", "host:not-a-uuid", `${slot}x`]) {
			assert.equal(isHostSlotId(bad), false, `accepted ${bad}`);
		}
	});
});

describe("broker slot table", () => {
	it("records one slot under both identities and reads it back", async () => {
		const store = createBrokerSlotStore(memento());
		const slot = createHostSlotId();
		assert.deepEqual(await store.record({ slot, conversation: "tab:a", editor: "editor-1" }), { ok: true });
		assert.equal(store.forConversation("tab:a"), slot);
		assert.equal(store.forEditor("editor-1"), slot);
		assert.equal(store.forConversation("tab:b"), null);
	});

	it("moves a conversation binding to the row the same host now serves", async () => {
		const store = createBrokerSlotStore(memento());
		const slot = createHostSlotId();
		await store.record({ slot, conversation: "tab:a", editor: "editor-1" });
		const moved = await store.repointConversation("tab:a", "tab:b");
		assert.deepEqual(moved, { ok: true, slot });
		assert.equal(store.forConversation("tab:a"), null, "the retired conversation keeps no mapping");
		assert.equal(store.forConversation("tab:b"), slot);
		// The editor slot is immutable, so its mapping is untouched.
		assert.equal(store.forEditor("editor-1"), slot);
	});

	it("refuses to overwrite a live incumbent's conversation mapping", async () => {
		const store = createBrokerSlotStore(memento());
		const incumbent = createHostSlotId();
		const newcomer = createHostSlotId();
		await store.record({ slot: incumbent, conversation: "tab:b", editor: "editor-incumbent" });
		await store.record({ slot: newcomer, conversation: "tab:a", editor: "editor-newcomer" });

		const refused = await store.repointConversation("tab:a", "tab:b");
		assert.equal(refused.ok, false, "two live writers may not share one conversation mapping");
		if (!refused.ok) assert.match(refused.reason, /already recorded/);
		// Both survive, each under its own immutable editor slot, and the incumbent
		// keeps the conversation it owns.
		assert.equal(store.forConversation("tab:b"), incumbent);
		assert.equal(store.forEditor("editor-incumbent"), incumbent);
		assert.equal(store.forEditor("editor-newcomer"), newcomer);
		assert.equal(store.forConversation("tab:a"), newcomer);
	});

	it("refuses a new host at the bound instead of evicting a recorded one", async () => {
		const store = createBrokerSlotStore(memento());
		const slots: string[] = [];
		for (let index = 0; index < BROKER_SLOT_LIMIT; index++) {
			const slot = createHostSlotId();
			slots.push(slot);
			const recorded = await store.record({ slot, conversation: `tab:${index}`, editor: `editor-${index}` });
			assert.equal(recorded.ok, true);
		}
		const refused = await store.record({
			slot: createHostSlotId(),
			conversation: "tab:one-more",
			editor: "editor-one-more",
		});
		assert.equal(refused.ok, false, "a full table must refuse rather than drop a possible live process");
		if (!refused.ok) assert.match(refused.reason, /no entry is dropped/);
		for (const [index, slot] of slots.entries()) {
			assert.equal(store.forConversation(`tab:${index}`), slot, `lost ${slot}`);
		}

		// Re-recording a slot the table already knows is not growth.
		const again = await store.record({ slot: slots[0]!, conversation: "tab:0", editor: "editor-0" });
		assert.equal(again.ok, true);

		// A positively stopped host frees its slot for reuse.
		await store.forget(slots[0]!);
		assert.equal(store.forConversation("tab:0"), null);
		assert.equal((await store.record({ slot: createHostSlotId(), conversation: "xtab", editor: "xeditor" })).ok, true);
	});

	it("does not remember a record a failed write never made durable", async () => {
		let fail = true;
		let value: unknown = null;
		const store = createBrokerSlotStore({
			get: (_key, fallback) => value ?? fallback,
			update: (_key, next) => {
				if (fail) return Promise.reject(new Error("workspace state is unwritable"));
				value = next;
				return Promise.resolve();
			},
		});
		const slot = createHostSlotId();
		await assert.rejects(() => store.record({ slot, conversation: "tab:a", editor: "editor-1" }));
		// The caller may not treat this as recorded: a launch that proceeded on a
		// phantom mapping would produce a process no restart could find.
		assert.equal(store.forConversation("tab:a"), null);
		fail = false;
		assert.deepEqual(await store.record({ slot, conversation: "tab:a", editor: "editor-1" }), { ok: true });
	});
});

/**
 * What the recorded provenance says, losslessly.
 *
 * The explicit release asks whether a writer may exist for one identity, so "no
 * slot is recorded", "this identity's mapping could not be read" and "a slot is
 * recorded" must stay three different answers: a lossy table must never be read as
 * absence.
 */
describe("broker slot provenance", () => {
	it("answers none, a slot, and unreadable apart", async () => {
		const store = createBrokerSlotStore(memento());
		const slot = createHostSlotId();

		assert.deepEqual(store.provenanceFor({ conversation: "tab:a" }), { kind: "none" });

		await store.record({ slot, conversation: "tab:a", editor: "editor-1" });
		assert.deepEqual(store.provenanceFor({ conversation: "tab:a" }), { kind: "slot", slot });
		assert.deepEqual(store.provenanceFor({ editor: "editor-1" }), { kind: "slot", slot });
		assert.deepEqual(store.provenanceFor({ conversation: "tab:b" }), { kind: "none" });
	});

	it("reports a mapping or a table it had to drop as unreadable, never as absent", () => {
		const dropped = createBrokerSlotStore(
			memento({ byEditor: { "editor-1": "not-a-slot" }, byConversation: { "tab:a": "not-a-slot" } }),
		);
		assert.deepEqual(dropped.provenanceFor({ conversation: "tab:a" }), { kind: "unreadable" });
		assert.deepEqual(dropped.provenanceFor({ editor: "editor-1" }), { kind: "unreadable" });
		assert.deepEqual(
			dropped.provenanceFor({ conversation: "tab:other" }),
			{ kind: "none" },
			"another identity's dropped mapping does not make this one unreadable",
		);

		const malformed = createBrokerSlotStore(memento("not-a-table"));
		assert.deepEqual(malformed.provenanceFor({ conversation: "tab:a" }), { kind: "unreadable" });
		assert.equal(malformed.forConversation("tab:a"), null, "the existing readers keep answering as before");
	});
});

describe("broker slot references", () => {
	it("lists every mapping and is complete for a table it wrote or read in full", async () => {
		const store = createBrokerSlotStore(memento());
		const slot = createHostSlotId();
		await store.record({ slot, conversation: "tab:a", editor: "editor-1" });
		assert.deepEqual(store.references(), {
			byConversation: { "tab:a": slot },
			byEditor: { "editor-1": slot },
			complete: true,
		});
		assert.equal(createBrokerSlotStore(memento()).references().complete, true, "an empty table is fully read");
	});

	it("reports a dropped value, a conflict marker or an unreadable table as incomplete", () => {
		const slot = createHostSlotId();
		const dropped = createBrokerSlotStore(memento({ byConversation: { "tab:a": slot, "tab:b": "not-a-slot" }, byEditor: {} }));
		assert.equal(dropped.references().complete, false);
		assert.deepEqual(dropped.references().byConversation, { "tab:a": slot }, "the readable mapping is still listed");
		const conflicted = createBrokerSlotStore(memento({ byConversation: {}, byEditor: {}, conflictedEditors: ["editor-1"] }));
		assert.equal(conflicted.references().complete, false);
		assert.equal(createBrokerSlotStore(memento("not-a-table")).references().complete, false);
	});
});
